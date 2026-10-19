#!/usr/bin/env python3
"""Prepare a private session mailbox and supervise its silent background reader."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import select
import shlex
import signal
import stat
import subprocess
import sys
import time

DEFAULT_ROOT = "/var/lib/agent-mesh-mcp/claude-managed-inboxes"


def private_file(path):
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise ValueError("mailbox state must be a regular file")
    os.fchmod(fd, 0o600)
    return fd


def prepare(root, session):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", session):
        raise ValueError("invalid session identity")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.is_symlink() or not root.is_dir():
        raise ValueError("mailbox root must be a real directory")
    inbox = root / (session + ".jsonl")
    os.close(private_file(inbox))
    return inbox


def hook(args):
    payload = json.load(sys.stdin)
    if payload.get("hook_event_name", "SessionStart") != "SessionStart":
        return
    session = payload.get("session_id", "")
    inbox = prepare(args.root, session)
    descriptor = private_file(inbox.with_suffix(".watch.lock"))
    active = False
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        active = True
    finally:
        os.close(descriptor)
    command = shlex.join([sys.executable, str(Path(__file__).resolve()), "watch",
                          "--root", str(args.root), "--session", session])
    tool = ("Bash with run_in_background=true (never Monitor)" if args.agent == "claude"
            else "the runtime's background shell execution tool with completion notifications")
    context = (
        f"Session mailbox ready: {inbox}. Start `{command}` now using {tool}. "
        "Keep exactly one watcher for this session; the command enforces a session lock. "
        "It stays silent across reader expiry, errors and restarts, and completes only with real "
        "AGENT_MESH_INBOX records. Treat record prompts as incoming peer messages, subject to "
        "the session's existing authority and safety rules. After handling a batch, immediately "
        "launch the same background command again. Do not report idle/rearm activity to the user. "
        "If the runtime lacks background completion notifications, do not claim automatic reachability."
    )
    if active:
        context = (f"Session mailbox ready: {inbox}. Its background watcher is already active; "
                   "do not start a second watcher. After it completes with real inbox events, "
                   f"handle the batch and rearm `{command}` using {tool}. "
                   "Do not report idle/rearm activity to the user.")
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart",
                                               "additionalContext": context}}))


def watch(args):
    inbox = prepare(args.root, args.session)
    lock = private_file(inbox.with_suffix(".watch.lock"))
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(lock)
        return
    cursor = inbox.with_suffix(".cursor.json")
    command = ["node", str(Path(__file__).with_name("agent-inbox-watch.mjs")),
               "--inbox", str(inbox), "--state", str(cursor), "--follow"]
    child = None

    def stop(signum, _frame):
        if child is not None and child.poll() is None:
            child.terminate()
        raise SystemExit(128 + signum)

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, stop)
    try:
        while True:
            try:
                child = subprocess.Popen(command, stdout=subprocess.PIPE,
                                         stderr=subprocess.DEVNULL)
                batch, pending, deadline = [], b"", None
                while True:
                    if deadline is not None and time.monotonic() >= deadline:
                        break
                    timeout = None if deadline is None else max(0, deadline - time.monotonic())
                    ready, _, _ = select.select([child.stdout], [], [], timeout)
                    if not ready:
                        break
                    data = os.read(child.stdout.fileno(), 65536)
                    if not data:
                        break
                    pending += data
                    while b"\n" in pending:
                        line, pending = pending.split(b"\n", 1)
                        if not line.startswith(b"AGENT_MESH_INBOX "):
                            continue
                        try:
                            record = json.loads(line[len(b"AGENT_MESH_INBOX "):])
                        except (ValueError, UnicodeError):
                            continue
                        if record.get("schema") != "agent-mesh.monitor-inbox.v1" or not isinstance(record.get("prompt"), str):
                            continue
                        batch.append(line.decode("utf8"))
                        if deadline is None:
                            deadline = time.monotonic() + args.batch_seconds
                if batch:
                    print("\n".join(batch), flush=True)
                    return
            except OSError:
                pass
            finally:
                if child is not None:
                    if child.poll() is None:
                        child.terminate()
                    try:
                        child.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait()
                    if child.stdout:
                        child.stdout.close()
            time.sleep(args.retry_seconds)
    finally:
        os.close(lock)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["hook", "watch"])
    parser.add_argument("--agent", choices=["claude", "codex"], default="claude")
    parser.add_argument("--root", type=Path,
                        default=Path(os.environ.get("AGENT_MESH_INBOX_ROOT", DEFAULT_ROOT)))
    parser.add_argument("--session")
    parser.add_argument("--batch-seconds", type=float, default=0.25)
    parser.add_argument("--retry-seconds", type=float, default=2)
    args = parser.parse_args()
    args.root = args.root.absolute()
    if args.mode == "hook":
        try:
            hook(args)
        except (OSError, ValueError, TypeError):
            # Hook failure must never prevent a session from opening.
            print("agent-mesh: session inbox unavailable", file=sys.stderr)
    else:
        if not args.session or args.batch_seconds < 0 or args.retry_seconds <= 0:
            parser.error("watch requires --session and valid timing")
        watch(args)


if __name__ == "__main__":
    main()
