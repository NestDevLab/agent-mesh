"""Durable, conservative delivery of one group message to an ordered member list.

The caller must authenticate the actor and choose the permitted destinations.
An accepted transport receipt is not a read or a completed turn.  An interrupted
or uncertain transport attempt is never retried or sent to a fallback member.
"""

from __future__ import annotations

import hashlib
import json
import os
import fcntl
import re
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys

from mesh_group_store import GroupActor, GroupStore


class DispatchError(ValueError):
    pass


def load_cloud_bindings(path):
    """Read a private account binding on each send, without following symlinks."""
    if path is None:
        return None
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
            raise ValueError("cloud binding file must be private and owned")
        payload = file.read(65537)
    if len(payload) > 65536:
        raise ValueError("cloud binding file too large")
    data = json.loads(payload)
    if not isinstance(data, dict):
        raise ValueError("cloud binding file must be an object")
    return data


_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.IGNORECASE)
_CLAUDE_CLOUD = re.compile(r"^claude-cloud:([a-z][a-z0-9-]{0,63}):((?:session|cse)_[A-Za-z0-9]{1,128})$")


def _identity(session_id):
    cloud = _CLAUDE_CLOUD.fullmatch(session_id)
    if cloud:
        return ["--agent", "claude", "--session", cloud.group(2), "--delivery-only", "--cloud"]
    runtime, _, raw_id = session_id.partition(":")
    if runtime not in ("codex", "claude") or not _UUID.fullmatch(raw_id):
        raise DispatchError("unsupported or invalid destination")
    if runtime == "codex":
        return ["--agent", "codex", "--session", session_id[6:], "--delivery-only", "--steer-or-queue", "--resume"]
    if runtime == "claude":
        return ["--agent", "claude", "--session", session_id[7:], "--delivery-only"]
    raise DispatchError("unsupported or unverified destination")


def _cloud_authorized(session_id, bindings):
    """Require an open registration and an explicitly bound authenticated account."""
    match = _CLAUDE_CLOUD.fullmatch(session_id)
    binding = bindings.get(match.group(1)) if match and isinstance(bindings, dict) else None
    if not isinstance(binding, dict) or set(binding) != {"email", "orgId"}:
        return False
    if not all(isinstance(binding[key], str) and binding[key] for key in ("email", "orgId")):
        return False
    try:
        graph = subprocess.run(["node", str(Path(__file__).with_name("mesh-graph.mjs")),
                                "cloud", "get", "--session", session_id], stdin=subprocess.DEVNULL,
                               capture_output=True, text=True, timeout=10, check=False)
        node = json.loads(graph.stdout)
        if graph.returncode != 0 or node.get("sessionId") != session_id:
            return False
        account = subprocess.run([os.environ.get("CLAUDE_BIN", "claude"), "auth", "status", "--json"],
                                 stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                 timeout=10, check=False)
        status = json.loads(account.stdout)
        return (account.returncode == 0 and status.get("loggedIn") is True
                and status.get("email") == binding["email"] and status.get("orgId") == binding["orgId"])
    except (OSError, ValueError, TypeError, AttributeError, subprocess.TimeoutExpired):
        return False


def native_transport(session_id, correlation, text, *, inbox_root=None, timeout=45, cloud_bindings=None):
    cloud = _CLAUDE_CLOUD.fullmatch(session_id)
    if cloud and not _cloud_authorized(session_id, cloud_bindings):
        return {"outcome": "blocked", "reason": "cloud_binding_unverified"}
    argv = ["node", str(Path(__file__).with_name("agent-native-call.mjs")), *_identity(session_id),
            "--correlation-id", correlation, "--message", text, "--timeout", str(timeout)]
    if inbox_root and session_id.startswith("claude:"):
        argv.extend(["--managed-inbox-root", str(inbox_root)])
    try:
        result = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                timeout=timeout + 20, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return {"outcome": "unknown"}
    try:
        receipt = json.loads(result.stdout.strip())
    except (ValueError, UnicodeError):
        return {"outcome": "unknown"}
    if not isinstance(receipt, dict):
        return {"outcome": "unknown"}
    runtime, exact_id = ("claude", cloud.group(2)) if cloud else session_id.split(":", 1)
    delivery = receipt.get("delivery")
    if (result.returncode == 78 and receipt.get("status") == "blocked"
            and receipt.get("agent") == runtime and receipt.get("sessionId") == exact_id
            and receipt.get("correlationId") == correlation
            and isinstance(delivery, dict) and delivery.get("attempted") is False):
        # Missing inbox alone does not prove a session is down. A complete
        # same-host ownership scan reporting no writer, together with a
        # verified pre-delivery refusal, does establish it cannot currently
        # receive through this active-session transport.
        ownership = receipt.get("ownership")
        discovery = ownership.get("discovery") if isinstance(ownership, dict) else None
        if (runtime == "claude" and isinstance(ownership, dict) and isinstance(discovery, dict)
                and ownership.get("state") == "free"
                and discovery.get("complete") is True
                and ownership.get("writers") == []):
            return {"outcome": "unavailable", "reason": "no_active_writer_and_no_delivery"}
        return {"outcome": "blocked", "reason": str(receipt.get("reason", "blocked"))}
    if result.returncode == 0 and receipt.get("held") is True:
        if receipt.get("agent") == runtime and receipt.get("sessionId") == exact_id and receipt.get("correlationId") == correlation:
            return {"outcome": "held", "receipt": receipt}
        return {"outcome": "unknown"}
    if result.returncode == 0 and receipt.get("status") in ("queued", "steered"):
        if receipt.get("agent") == runtime and receipt.get("sessionId") == exact_id and receipt.get("correlationId") == correlation:
            return {"outcome": "accepted", "receipt": receipt}
    return {"outcome": "unknown"}


def dispatch(store, actor, group_id, message_id, message, destinations, transport=native_transport):
    """Return the existing receipt or attempt each proven-unavailable member once.

    `destinations` is an explicit ordered preference list. A timeout, a crash, a
    held message or an ambiguous response never causes another delivery attempt.
    The local store and the actor binding are trusted host boundaries.
    """
    if not isinstance(actor, GroupActor) or not actor.session_id:
        raise DispatchError("authenticated member actor required")
    if (not isinstance(destinations, list) or not destinations or len(destinations) > 32
            or any(not isinstance(d, str) for d in destinations) or len(set(destinations)) != len(destinations)):
        raise DispatchError("ordered unique destinations required")
    if (not isinstance(message_id, str) or not message_id or len(message_id) > 128
            or message_id != message_id.strip() or not message_id.isprintable()):
        raise DispatchError("message id required")
    if (not isinstance(message, str) or not 0 < len(message) <= 32000
            or not message.strip() or "\0" in message):
        raise DispatchError("message must contain 1 to 32000 characters and no NUL")
    try:
        message.encode("utf-8")
        message_id.encode("utf-8")
    except UnicodeEncodeError:
        raise DispatchError("message and id must be valid UTF-8") from None
    group = store.get_group(actor, group_id)
    members = {m["session_id"] for m in group["members"]}
    if actor.session_id not in members:
        raise DispatchError("sender must be a member of the group")
    if any(not isinstance(d, str) or d not in members or d == actor.session_id for d in destinations):
        raise DispatchError("destinations must be other members of the group")
    for destination in destinations:
        _identity(destination)
    payload = json.dumps({"group": group_id, "id": message_id, "author": actor.session_id,
                          "text": message, "destinations": destinations}, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(payload.encode()).hexdigest()
    dbpath = store.state_dir / "group-delivery.sqlite3"
    # Hold a short lock on the directory inode while closing a newly-created
    # file and opening SQLite. Closing a second FD for an existing SQLite inode
    # in this process can silently drop that process's POSIX record locks.
    dirfd = os.open(store.state_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fcntl.flock(dirfd, fcntl.LOCK_EX)
        try:
            fd = os.open(dbpath, os.O_CREAT | os.O_EXCL | os.O_RDONLY | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            pass
        else:
            os.close(fd)
        info = dbpath.lstat()
        if not dbpath.is_file() or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
            raise DispatchError("delivery store must be private and owned")
        db = sqlite3.connect(dbpath, timeout=5, isolation_level=None)
    finally:
        os.close(dirfd)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA synchronous=FULL")
        db.execute("CREATE TABLE IF NOT EXISTS deliveries (group_id TEXT, message_id TEXT, digest TEXT NOT NULL, state TEXT NOT NULL, position INTEGER NOT NULL, receipt TEXT, PRIMARY KEY(group_id, message_id))")
        db.execute("BEGIN IMMEDIATE")
        previous = db.execute("SELECT * FROM deliveries WHERE group_id=? AND message_id=?", (group_id, message_id)).fetchone()
        if previous:
            if previous["digest"] != digest:
                raise DispatchError("message id conflicts with existing delivery")
            db.commit()
            return {"status": "unknown" if previous["state"] in ("preparing", "dispatching") else previous["state"],
                    "receipt": json.loads(previous["receipt"]) if previous["receipt"] else None,
                    "duplicate": True, "message_seq": None}
        # Bind recipients and payload before history or any external call. A
        # crash leaves an uncertain intent rather than permitting substitution.
        db.execute("INSERT INTO deliveries VALUES (?, ?, ?, 'preparing', 0, NULL)", (group_id, message_id, digest))
        db.commit()
        appended = store.append_message(actor, group_id, message, message_id=message_id)
        if appended["duplicate"]:
            db.execute("BEGIN IMMEDIATE")
            db.execute("UPDATE deliveries SET state='blocked' WHERE group_id=? AND message_id=?", (group_id, message_id))
            db.commit()
            raise DispatchError("message exists without a matching delivery intent")
        record = appended["message"]
        db.execute("BEGIN IMMEDIATE")
        db.execute("UPDATE deliveries SET state='dispatching' WHERE group_id=? AND message_id=? AND state='preparing'", (group_id, message_id))
        db.commit()
        for position, destination in enumerate(destinations):
            # Admission is evaluated at the last group check before each send.
            # Removal after this point cannot revoke an already admitted call.
            try:
                live_group = store.get_group(actor, group_id)
                live_members = {m["session_id"] for m in live_group["members"]}
                authorized = actor.session_id in live_members and destination in live_members
            except ValueError:
                authorized = False
            if not authorized:
                outcome = {"outcome": "blocked", "reason": "membership_changed"}
                db.execute("BEGIN IMMEDIATE")
                db.execute("UPDATE deliveries SET state='blocked', receipt=? WHERE group_id=? AND message_id=? AND state='dispatching'",
                           (json.dumps(outcome), group_id, message_id))
                db.commit()
                return {"status": "blocked", "receipt": outcome, "duplicate": False,
                        "message_seq": record["seq"], "destination": destination, "read_back": False}
            correlation = "group-" + hashlib.sha256((group_id + "\0" + message_id + "\0" + destination).encode()).hexdigest()[:32]
            prompt = (f"[Agent Mesh group {group_id}; message {message_id}; from {actor.session_id}]\n"
                      f"Use the group history for shared context; post replies to the group history.\n{message}")
            try:
                outcome = transport(destination, correlation, prompt)
            except Exception:
                outcome = {"outcome": "unknown"}
            state = outcome.get("outcome", "unknown") if isinstance(outcome, dict) else "unknown"
            if state not in ("accepted", "held", "blocked", "unavailable", "unknown"):
                state = "unknown"
            last = position == len(destinations) - 1
            # The next attempt remains durably marked dispatching across crashes.
            persisted = "unavailable" if state == "unavailable" and last else ("dispatching" if state == "unavailable" else state)
            db.execute("BEGIN IMMEDIATE")
            db.execute("UPDATE deliveries SET state=?, position=?, receipt=? WHERE group_id=? AND message_id=? AND state='dispatching'",
                       (persisted, position, json.dumps(outcome), group_id, message_id))
            db.commit()
            if state != "unavailable" or last:
                return {"status": state, "receipt": outcome, "duplicate": False, "message_seq": record["seq"],
                        "destination": destination, "read_back": False}
    finally:
        db.close()
