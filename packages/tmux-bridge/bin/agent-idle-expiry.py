#!/usr/bin/env python3
"""Safely expire managed, continuously idle Agent Mesh tmux sessions.

This program deliberately has no timer of its own.  Invoke it from an approved
periodic scheduler.  It derives activity from agent-read.sh, so the bridge's
agent-specific idle, working, approval-pending, and error classifiers remain
the authority.  A close is opt-in (--execute) and always goes through
agent-session.sh rather than injecting keys into a pane.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
BRIDGE_DIR = SCRIPT_DIR.parent
AGENTS_DIR = Path(os.environ.get("AGENT_MESH_AGENTS_DIR", BRIDGE_DIR / "agents"))
READ_BIN = SCRIPT_DIR / "agent-read.sh"
SESSION_BIN = SCRIPT_DIR / "agent-session.sh"
STATE_VERSION = 1
KNOWN_STATUSES = {"idle", "working", "approval-pending", "error"}


class ReaperError(RuntimeError):
    """An observation was not trustworthy enough to continue."""


class StateStore:
    def __init__(self, path: Path, writable: bool) -> None:
        self.path = path
        self.writable = writable
        self.lock_handle: Any | None = None
        self.data: dict[str, Any] = {"version": STATE_VERSION, "targets": {}}

    def open(self) -> None:
        if self.writable:
            self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            lock_path = self.path.with_name(f"{self.path.name}.lock")
            self.lock_handle = open(lock_path, "a+", encoding="utf-8")
            os.chmod(lock_path, 0o600)
            try:
                fcntl.flock(self.lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise ReaperError("another idle-expiry run holds the state lock") from exc

        if not self.path.exists():
            return
        try:
            loaded = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ReaperError(f"state is unreadable: {self.path}") from exc
        if not isinstance(loaded, dict) or loaded.get("version") != STATE_VERSION:
            raise ReaperError(f"state has an unsupported schema: {self.path}")
        if not isinstance(loaded.get("targets"), dict):
            raise ReaperError(f"state has no target map: {self.path}")
        self.data = loaded

    def write(self) -> None:
        if not self.writable:
            return
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        payload = json.dumps(self.data, sort_keys=True, indent=2) + "\n"
        fd, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                os.fchmod(handle.fileno(), 0o600)
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
            os.chmod(self.path, 0o600)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def close(self) -> None:
        if self.lock_handle is not None:
            fcntl.flock(self.lock_handle.fileno(), fcntl.LOCK_UN)
            self.lock_handle.close()


def non_negative(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a whole number of seconds") from exc
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be zero or greater")
    return parsed


def default_state_path() -> Path:
    base = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state"))
    return base / "agent-mesh" / "idle-expiry.json"


def run(command: list[str], *, timeout: int = 20) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(command, text=True, capture_output=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ReaperError(f"could not run {' '.join(command[:2])}") from exc


def tmux(socket: str, arguments: list[str], *, timeout: int = 20) -> subprocess.CompletedProcess[str]:
    return run(["tmux", "-L", socket, *arguments], timeout=timeout)


def managed_targets(socket: str, prefix: str, agent: str, restricted: set[str]) -> list[str]:
    result = tmux(socket, ["list-sessions", "-F", "#{session_name}"])
    if result.returncode != 0:
        # No mesh server is a normal, safe empty result. Other failures cannot
        # produce an expiry action either.
        detail = result.stderr.lower()
        if (
            "no server running" in detail
            or "failed to connect" in detail
            or ("error connecting to" in detail and "no such file or directory" in detail)
        ):
            return []
        raise ReaperError(f"cannot list managed sessions: {result.stderr.strip()}")
    target_prefix = f"{prefix}-{agent}"
    return sorted(
        name
        for name in result.stdout.splitlines()
        if (name == target_prefix or name.startswith(f"{target_prefix}-"))
        and (not restricted or name in restricted)
    )


def pane_identity(socket: str, target: str) -> tuple[str, str | None]:
    result = tmux(
        socket,
        ["list-panes", "-t", target, "-F", "#{session_created}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}"],
    )
    if result.returncode != 0:
        return "", "pane-inspection-failed"
    rows = [row.split("\t", 3) for row in result.stdout.splitlines() if row]
    if len(rows) != 1 or len(rows[0]) != 4:
        return "", "session-does-not-have-exactly-one-pane"
    created, pane_id, pane_pid, command = rows[0]
    if not all((created, pane_id, pane_pid, command)):
        return "", "pane-identity-is-incomplete"
    return f"{created}:{pane_id}:{pane_pid}:{command}", None


def alive_pattern(agent: str) -> str | None:
    conf = AGENTS_DIR / f"{agent}.conf"
    if not conf.is_file():
        return None
    result = run(
        ["bash", "-c", 'source "$1"; printf "%s" "${AGENT_ALIVE_PROCESS_PATTERN:-}"', "idle-expiry", str(conf)]
    )
    if result.returncode != 0 or not result.stdout:
        return None
    return result.stdout


def current_command(identity: str) -> str:
    return identity.rsplit(":", 1)[1]


def classify(socket: str, agent: str, target: str, identity: str, process_pattern: str) -> tuple[str | None, str | None]:
    try:
        if re.fullmatch(process_pattern, current_command(identity)) is None:
            return None, "pane-process-is-not-the-configured-agent"
    except re.error:
        return None, "agent-alive-process-pattern-is-invalid"

    result = run([str(READ_BIN), "--agent", agent, target, "--status"])
    status = result.stdout.strip()
    if result.returncode != 0 or status not in KNOWN_STATUSES:
        return None, "agent-status-is-uncertain"
    return status, None


def state_key(socket: str, agent: str, target: str) -> str:
    return f"{socket}\t{agent}\t{target}"


def base_entry(identity: str, now: int, status: str, phase: str, reason: str | None = None) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "identity": identity,
        "last_checked_at": now,
        "last_status": status,
        "phase": phase,
    }
    if reason:
        entry["reason"] = reason
    return entry


def clear_idle(entry: dict[str, Any]) -> None:
    entry.pop("idle_since", None)
    entry.pop("grace_started_at", None)


def session_gone(socket: str, target: str) -> bool | None:
    result = tmux(socket, ["has-session", "-t", target])
    if result.returncode == 0:
        return False
    if result.returncode == 1:
        return True
    return None


def print_report(records: list[dict[str, Any]], as_json: bool) -> None:
    if as_json:
        print(json.dumps({"targets": records}, sort_keys=True, indent=2))
        return
    if not records:
        print("IDLE-EXPIRY: no managed Codex or Claude sessions found")
        return
    for record in records:
        detail = record.get("reason") or record.get("status", "unknown")
        print(f"IDLE-EXPIRY: {record['agent']} {record['target']} {record['action']} ({detail})")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent", action="append", dest="agents", help="agent config to inspect; repeatable (default: codex and claude)")
    parser.add_argument("--target", action="append", dest="targets", help="limit inspection to this managed tmux target; repeatable")
    parser.add_argument("--state", type=Path, default=default_state_path(), help="runtime state JSON path")
    parser.add_argument("--idle-seconds", type=non_negative, default=non_negative(os.environ.get("MESH_IDLE_EXPIRY_SECONDS", "18000")))
    parser.add_argument("--grace-seconds", type=non_negative, default=non_negative(os.environ.get("MESH_IDLE_EXPIRY_GRACE_SECONDS", "300")))
    parser.add_argument("--max-check-gap-seconds", type=non_negative, default=non_negative(os.environ.get("MESH_IDLE_EXPIRY_MAX_CHECK_GAP_SECONDS", "900")))
    parser.add_argument("--delivery-guard", type=Path, default=Path(os.environ["MESH_IDLE_EXPIRY_DELIVERY_GUARD"]) if os.environ.get("MESH_IDLE_EXPIRY_DELIVERY_GUARD") else None)
    parser.add_argument("--execute", action="store_true", help="persist observations and permit one managed close after the grace re-check")
    parser.add_argument("--dry-run", action="store_true", help="explicitly inspect only; this is also the default")
    parser.add_argument("--json", action="store_true", help="emit a JSON inspection report")
    options = parser.parse_args()
    if options.execute and options.dry_run:
        parser.error("--execute and --dry-run cannot be combined")
    return options


def main() -> int:
    options = parse_args()
    agents = options.agents or ["codex", "claude"]
    if len(set(agents)) != len(agents):
        raise ReaperError("each --agent value may appear only once")
    for agent in agents:
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", agent) or not (AGENTS_DIR / f"{agent}.conf").is_file():
            raise ReaperError(f"unknown agent config: {agent}")

    socket = os.environ.get("MESH_TMUX_SOCKET", "mesh")
    prefix = os.environ.get("TMUX_SESSION_PREFIX", "mesh")
    restricted_targets = set(options.targets or [])
    store = StateStore(options.state, options.execute)
    store.open()
    records: list[dict[str, Any]] = []
    now = int(time.time())

    delivery_guard_reason: str | None = None
    if options.delivery_guard is not None:
        try:
            if options.delivery_guard.exists():
                delivery_guard_reason = "delivery-guard-present"
        except OSError:
            delivery_guard_reason = "delivery-guard-is-uncertain"

    try:
        for agent in agents:
            pattern = alive_pattern(agent)
            targets = managed_targets(socket, prefix, agent, restricted_targets)
            for target in targets:
                key = state_key(socket, agent, target)
                identity, identity_reason = pane_identity(socket, target)
                existing = store.data["targets"].get(key, {})
                if identity_reason:
                    if options.execute:
                        entry = base_entry(existing.get("identity", "unknown"), now, "uncertain", "uncertain", identity_reason)
                        store.data["targets"][key] = entry
                    records.append({"agent": agent, "target": target, "action": "skip", "reason": identity_reason})
                    continue

                # A target name may be reused after the old client was removed.
                # Never carry its old idle clock or close uncertainty forward.
                if existing.get("identity") != identity:
                    existing = {}

                if existing.get("phase") in {"close-pending", "close-uncertain"}:
                    if options.execute:
                        entry = base_entry(identity, now, "uncertain", "close-uncertain", "previous-close-outcome-is-uncertain")
                        entry["close_attempted_at"] = existing.get("close_attempted_at", now)
                        store.data["targets"][key] = entry
                    records.append({"agent": agent, "target": target, "action": "skip", "reason": "previous-close-outcome-is-uncertain"})
                    continue

                if not pattern:
                    if options.execute:
                        store.data["targets"][key] = base_entry(identity, now, "uncertain", "uncertain", "agent-alive-process-pattern-is-missing")
                    records.append({"agent": agent, "target": target, "action": "skip", "reason": "agent-alive-process-pattern-is-missing"})
                    continue

                status, status_reason = classify(socket, agent, target, identity, pattern)
                if status_reason:
                    if options.execute:
                        store.data["targets"][key] = base_entry(identity, now, "uncertain", "uncertain", status_reason)
                    records.append({"agent": agent, "target": target, "action": "skip", "reason": status_reason})
                    continue

                if delivery_guard_reason:
                    if options.execute:
                        store.data["targets"][key] = base_entry(identity, now, status, "guarded", delivery_guard_reason)
                    records.append({"agent": agent, "target": target, "status": status, "action": "skip", "reason": delivery_guard_reason})
                    continue

                if status != "idle":
                    if options.execute:
                        store.data["targets"][key] = base_entry(identity, now, status, "active", status)
                    records.append({"agent": agent, "target": target, "status": status, "action": "keep", "reason": status})
                    continue

                last_checked = existing.get("last_checked_at")
                continuous = (
                    existing.get("last_status") == "idle"
                    and isinstance(existing.get("idle_since"), int)
                    and isinstance(last_checked, int)
                    and now >= last_checked
                    and now - last_checked <= options.max_check_gap_seconds
                )
                entry = dict(existing) if continuous else base_entry(identity, now, "idle", "observing")
                entry.update({"identity": identity, "last_checked_at": now, "last_status": "idle"})
                if not continuous:
                    entry["idle_since"] = now
                    entry["phase"] = "observing"
                    entry.pop("grace_started_at", None)

                idle_for = now - entry["idle_since"]
                if idle_for < options.idle_seconds:
                    if options.execute:
                        store.data["targets"][key] = entry
                    records.append({"agent": agent, "target": target, "status": "idle", "action": "observe", "reason": f"idle-for={idle_for}s"})
                    continue

                grace_started = entry.get("grace_started_at")
                if not isinstance(grace_started, int):
                    entry["grace_started_at"] = now
                    entry["phase"] = "grace"
                    if options.execute:
                        store.data["targets"][key] = entry
                    records.append({"agent": agent, "target": target, "status": "idle", "action": "grace", "reason": f"idle-for={idle_for}s"})
                    continue

                if now - grace_started < options.grace_seconds:
                    entry["phase"] = "grace"
                    if options.execute:
                        store.data["targets"][key] = entry
                    records.append({"agent": agent, "target": target, "status": "idle", "action": "grace", "reason": f"grace-for={now - grace_started}s"})
                    continue

                # The second status and pane-identity inspection is the expiry
                # checkpoint. A stale observation is never enough to close.
                final_identity, final_identity_reason = pane_identity(socket, target)
                final_status, final_status_reason = (
                    classify(socket, agent, target, final_identity, pattern)
                    if not final_identity_reason and final_identity == identity
                    else (None, final_identity_reason or "pane-identity-changed-before-close")
                )
                if final_status != "idle":
                    if options.execute:
                        refreshed = base_entry(final_identity or identity, now, final_status or "uncertain", "uncertain", final_status_reason)
                        clear_idle(refreshed)
                        store.data["targets"][key] = refreshed
                    records.append({"agent": agent, "target": target, "action": "skip", "reason": final_status_reason or final_status or "close-checkpoint-failed"})
                    continue

                if not options.execute:
                    records.append({"agent": agent, "target": target, "status": "idle", "action": "would-close", "reason": "grace-and-checkpoint-passed"})
                    continue

                # Persist intent *before* dispatching. If the host dies while the
                # managed close is in flight, a later run records uncertainty and
                # refuses to retry automatically.
                entry["phase"] = "close-pending"
                entry["close_attempted_at"] = now
                store.data["targets"][key] = entry
                store.write()
                close = run([str(SESSION_BIN), "--agent", agent, "kill", target])
                gone = session_gone(socket, target)
                if close.returncode == 0 and gone is True:
                    closed = base_entry(identity, now, "closed", "closed")
                    closed["idle_since"] = entry["idle_since"]
                    closed["closed_at"] = now
                    store.data["targets"][key] = closed
                    records.append({"agent": agent, "target": target, "status": "idle", "action": "closed", "reason": "managed-close-confirmed"})
                else:
                    uncertain = base_entry(identity, now, "uncertain", "close-uncertain", "managed-close-outcome-is-uncertain")
                    uncertain["close_attempted_at"] = now
                    store.data["targets"][key] = uncertain
                    records.append({"agent": agent, "target": target, "action": "skip", "reason": "managed-close-outcome-is-uncertain"})

        if options.execute:
            store.write()
        print_report(records, options.json)
        return 0
    finally:
        store.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ReaperError as error:
        print(f"IDLE-EXPIRY: ERROR: {error}", file=sys.stderr)
        raise SystemExit(75 if "state lock" in str(error) else 2)
