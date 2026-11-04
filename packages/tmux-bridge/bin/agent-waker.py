#!/usr/bin/env python3
"""Run a cheap producer and wake the owning session only when it reports something new.

The producer prints one JSON object {"new": [...], "errors": [...]}; it owns its own cursor, so
every item it returns is new. Undelivered items stay pending in the waker state and are retried, so
a refused delivery never drops them. Errors wake the session once per distinct error set.
"""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from typing import Any

BIN = Path(__file__).resolve().parent
SCHEMA = "agent-mesh.waker-state.v1"
# agent-native-call exit codes that mean the turn was queued: result seen, empty result, wait timed out.
QUEUED = {0, 65, 124}
MAX_LISTED = 40
MAX_LINE = 400


def state_dir() -> Path:
    base = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local/state")
    return Path(base) / "agent-waker"


def item_key(item: Any) -> str:
    return hashlib.sha256(json.dumps(item, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]


def error_signature(errors: list[Any]) -> str | None:
    if not errors:
        return None
    canonical = sorted(json.dumps(error, sort_keys=True, ensure_ascii=False) for error in errors)
    return hashlib.sha256("\n".join(canonical).encode()).hexdigest()[:16]


def load_state(path: Path) -> tuple[dict[str, Any], list[dict[str, str]]]:
    empty = {"schema": SCHEMA, "pending": [], "errorSignature": None}
    if not path.exists():
        return empty, []
    try:
        state = json.loads(path.read_text())
        if not isinstance(state.get("pending"), list):
            raise ValueError("pending is not a list")
        return state, []
    except (OSError, ValueError) as error:
        return empty, [{"source": "waker-state", "error": f"unreadable state reset: {error}"}]


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n")
    os.replace(temporary, path)


@contextmanager
def locked(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path.with_suffix(".lock"), "w") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        yield True


def run_producer(command: list[str], timeout: int) -> tuple[list[Any], list[Any]]:
    try:
        done = subprocess.run(command, text=True, capture_output=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        return [], [{"source": "producer", "error": f"{type(error).__name__}: {error}"}]
    try:
        report = json.loads(done.stdout)
        new, errors = report["new"], report.get("errors") or []
        if not isinstance(new, list) or not isinstance(errors, list):
            raise ValueError("new/errors must be lists")
    except (ValueError, KeyError, TypeError) as error:
        tail = (done.stderr or done.stdout).strip()[-300:]
        return [], [{"source": "producer", "error": f"exit {done.returncode}, unusable report ({error}): {tail}"}]
    return new, errors


def compose(job: str, pending: list[dict[str, Any]], errors: list[Any]) -> str:
    lines = [f"agent-waker {job}: {len(pending)} new item(s), {len(errors)} source error(s). "
             "Act on these; the waker already advanced the cursor and will not resend them."]
    for entry in pending[:MAX_LISTED]:
        lines.append("NEW " + json.dumps(entry["item"], ensure_ascii=False)[:MAX_LINE])
    if len(pending) > MAX_LISTED:
        lines.append(f"... {len(pending) - MAX_LISTED} more; rerun the producer with --peek to list them.")
    for error in errors:
        lines.append("ERROR " + json.dumps(error, ensure_ascii=False)[:MAX_LINE])
    return "\n".join(lines)


def deliver(agent: str, session: str, correlation: str, message: str, inbox_root: str | None, delivery_only: bool = False, resume: bool = False) -> int:
    command = ["node", str(BIN / "agent-native-call.mjs"), "--agent", agent, "--session", session,
               "--correlation-id", correlation, "--timeout", "5", "--message", message]
    if resume:
        if agent != "codex":
            raise ValueError("waker resume is supported only for Codex")
        command += ["--resume"]
    if delivery_only:
        command += ["--delivery-only"]
    if inbox_root:
        command += ["--managed-inbox-root", inbox_root]
    return subprocess.run(command, text=True, capture_output=True).returncode


def record(job: str, outcome: str, session: str, note: str) -> None:
    subprocess.run([sys.executable, "-I", str(BIN / "agent-run-receipt.py"), "record", "--job", job,
                    "--outcome", outcome, "--trigger", "timer", "--session", session, "--note", note],
                   capture_output=True)


def run(args: argparse.Namespace) -> int:
    path = Path(args.state) if args.state else state_dir() / f"{args.job}.json"
    with locked(path) as acquired:
        if not acquired:
            print(json.dumps({"job": args.job, "outcome": "noop", "reason": "previous run still active"}))
            return 0
        state, state_errors = load_state(path)
        new, errors = run_producer(args.producer, args.producer_timeout)
        errors = state_errors + errors
        known = {entry["key"] for entry in state["pending"]}
        for item in new:
            key = item_key(item)
            if key not in known:
                known.add(key)
                state["pending"].append({"key": key, "item": item})
        signature = error_signature(errors)
        wake_errors = errors if signature and signature != state.get("errorSignature") else []
        if not errors:
            state["errorSignature"] = None
        # Persist before delivering so a crash after the producer advanced its cursor keeps the items.
        save_state(path, state)
        summary = {"job": args.job, "new": len(new), "pending": len(state["pending"]), "errors": len(errors)}
        if not state["pending"] and not wake_errors:
            record(args.job, "noop", args.session, "nothing new")
            print(json.dumps({**summary, "outcome": "noop"}))
            return 0
        correlation = f"waker-{args.job}-{int(time.time())}"
        code = deliver(args.agent, args.session, correlation, compose(args.job, state["pending"], wake_errors),
                       args.managed_inbox_root, args.delivery_only, **({"resume": True} if args.resume else {}))
        if code not in QUEUED:
            record(args.job, "blocked", args.session, f"delivery refused rc={code}")
            print(json.dumps({**summary, "outcome": "blocked", "deliveryExit": code}))
            return 3
        state["lastDelivery"] = {"correlationId": correlation, "at": time.time(),
                                 "itemKeys": [entry["key"] for entry in state["pending"]]}
        state["pending"] = []
        if signature:
            state["errorSignature"] = signature
        save_state(path, state)
        record(args.job, "acted", args.session, f"delivered {summary['pending']} item(s), {len(wake_errors)} error(s)")
        print(json.dumps({**summary, "outcome": "acted", "correlationId": correlation, "deliveryExit": code}))
        return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    runner = sub.add_parser("run", help="run the producer once and deliver anything new")
    runner.add_argument("--job", required=True)
    runner.add_argument("--agent", default="claude", choices=("claude", "codex"))
    runner.add_argument("--session", required=True, help="owning session UUID")
    runner.add_argument("--managed-inbox-root", help="required for Claude sessions")
    runner.add_argument("--delivery-only", action="store_true", help="acknowledge the native queue, without waiting for a result")
    runner.add_argument("--resume", action="store_true", help="opt in to native Codex resume when idle")
    runner.add_argument("--state", help="defaults to $XDG_STATE_HOME/agent-waker/<job>.json")
    runner.add_argument("--producer-timeout", type=int, default=280)
    runner.add_argument("producer", nargs=argparse.REMAINDER, help="-- command that prints the JSON report")
    args = parser.parse_args(argv)
    if args.resume and args.agent != "codex":
        parser.error("--resume requires --agent codex")
    if args.producer[:1] == ["--"]:
        args.producer = args.producer[1:]
    if not args.producer:
        parser.error("missing producer command after --")
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
