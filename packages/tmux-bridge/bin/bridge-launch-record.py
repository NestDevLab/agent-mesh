#!/usr/bin/env python3
"""Append and reconcile attributable tmux-bridge launch events."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import sqlite3
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path


SCHEMA = "agent-mesh.bridge-launch-event.v1"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def append_event(path: Path, event: dict) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        path.parent.chmod(0o700)
    except OSError:
        pass
    lock_path = path.with_suffix(path.suffix + ".lock")
    with lock_path.open("a", encoding="utf-8") as lock:
        os.chmod(lock_path, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        with path.open("a", encoding="utf-8") as stream:
            os.chmod(path, 0o600)
            stream.write(json.dumps(event, sort_keys=True, separators=(",", ":")) + "\n")
            stream.flush()
            os.fsync(stream.fileno())


def read_events(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    events = []
    lock_path = path.with_suffix(path.suffix + ".lock")
    with lock_path.open("a", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_SH)
        with path.open(encoding="utf-8") as stream:
            for line in stream:
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(value, dict) and value.get("schema") == SCHEMA:
                    events.append(value)
    return events


def route_fields(raw: str) -> tuple[str | None, str | None]:
    if not raw:
        return None, None
    try:
        route = json.loads(raw)
    except json.JSONDecodeError:
        return None, None
    if not isinstance(route, dict):
        return None, None
    model = route.get("nativeModel")
    effort = route.get("effort")
    return (model if isinstance(model, str) and model else None,
            effort if isinstance(effort, str) and effort else None)


def start(args: argparse.Namespace) -> int:
    launched_at_ms = args.launched_at_ms if args.launched_at_ms is not None else time.time_ns() // 1_000_000
    launched_at = datetime.fromtimestamp(launched_at_ms / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    model, effort = route_fields(args.route_json)
    if model is None:
        model = args.model
    if effort is None:
        effort = args.effort
    launch_id = str(uuid.uuid4())
    event = {
        "schema": SCHEMA,
        "event": "launch.started",
        "eventId": str(uuid.uuid4()),
        "launchId": launch_id,
        "recordedAt": utc_now(),
        "origin": "tmux-bridge",
        "agent": args.agent,
        "tmuxTarget": args.target,
        "threadId": args.thread_id,
        "profile": args.profile,
        "model": model,
        "effort": effort,
        "cwd": args.cwd,
        "launchedAt": launched_at,
        "launchedAtMs": launched_at_ms,
        "caller": args.caller,
        "route": {"status": args.route_status, "reason": args.route_reason},
    }
    append_event(args.state, event)
    print(json.dumps(event, sort_keys=True))
    return 0


def latest_open_launch(events: list[dict], target: str, agent: str) -> dict | None:
    resolved = {
        event.get("launchId")
        for event in events
        if event.get("event") == "launch.thread_resolved" and event.get("threadId")
    }
    for event in reversed(events):
        if (event.get("event") == "launch.started" and event.get("tmuxTarget") == target
                and event.get("agent") == agent and event.get("launchId") not in resolved):
            return event
    return None


def codex_candidates(db_path: Path, cwd: str, launched_at_ms: int) -> list[str]:
    uri = f"file:{db_path}?mode=ro"
    with sqlite3.connect(uri, uri=True, timeout=1) as connection:
        rows = connection.execute(
            """
            SELECT t.id
              FROM threads AS t
             WHERE t.cwd = ?
               AND COALESCE(t.created_at_ms, t.created_at * 1000) >= ?
               AND NOT EXISTS (
                   SELECT 1 FROM thread_spawn_edges AS e WHERE e.child_thread_id = t.id
               )
             ORDER BY COALESCE(t.created_at_ms, t.created_at * 1000), t.id
            """,
            (cwd, launched_at_ms),
        ).fetchall()
    return [row[0] for row in rows]


def reconcile(args: argparse.Namespace) -> int:
    events = read_events(args.state)
    launch = latest_open_launch(events, args.target, args.agent)
    if launch is None:
        return 0
    if launch.get("threadId"):
        print(launch["threadId"])
        return 0

    candidates: list[str] = []
    error = None
    if args.agent != "codex":
        error = "unsupported_agent"
    elif not args.codex_db.is_file():
        error = "database_unavailable"
    else:
        for attempt in range(args.attempts):
            try:
                candidates = codex_candidates(args.codex_db, launch["cwd"], launch["launchedAtMs"])
            except (OSError, sqlite3.Error) as exc:
                error = f"database_error:{type(exc).__name__}"
                break
            if candidates or attempt + 1 == args.attempts:
                break
            time.sleep(args.retry_ms / 1000)

    thread_id = candidates[0] if len(candidates) == 1 else None
    event = {
        "schema": SCHEMA,
        "event": "launch.thread_resolved" if thread_id else "launch.thread_ambiguous",
        "eventId": str(uuid.uuid4()),
        "launchId": launch["launchId"],
        "recordedAt": utc_now(),
        "origin": "tmux-bridge",
        "agent": args.agent,
        "tmuxTarget": args.target,
        "threadId": thread_id,
        "candidateCount": len(candidates),
        "reason": error or ("exact_match" if thread_id else "candidate_count_not_one"),
    }
    append_event(args.state, event)
    if thread_id:
        print(thread_id)
    return 0


def show(args: argparse.Namespace) -> int:
    events = read_events(args.state)
    if args.target:
        events = [event for event in events if event.get("tmuxTarget") == args.target]
    for event in events:
        print(json.dumps(event, sort_keys=True))
    return 0


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--state", type=Path, required=True)
    commands = result.add_subparsers(dest="command", required=True)

    start_parser = commands.add_parser("start")
    start_parser.add_argument("--agent", required=True)
    start_parser.add_argument("--target", required=True)
    start_parser.add_argument("--cwd", required=True)
    start_parser.add_argument("--thread-id")
    start_parser.add_argument("--profile")
    start_parser.add_argument("--model")
    start_parser.add_argument("--effort")
    start_parser.add_argument("--route-json", default="")
    start_parser.add_argument("--route-status", required=True)
    start_parser.add_argument("--route-reason")
    start_parser.add_argument("--caller", default="unknown")
    start_parser.add_argument("--launched-at-ms", type=int)
    start_parser.set_defaults(handler=start)

    reconcile_parser = commands.add_parser("reconcile")
    reconcile_parser.add_argument("--agent", required=True)
    reconcile_parser.add_argument("--target", required=True)
    reconcile_parser.add_argument("--codex-db", type=Path, required=True)
    reconcile_parser.add_argument("--attempts", type=int, default=10)
    reconcile_parser.add_argument("--retry-ms", type=int, default=100)
    reconcile_parser.set_defaults(handler=reconcile)

    show_parser = commands.add_parser("show")
    show_parser.add_argument("--target")
    show_parser.set_defaults(handler=show)
    return result


def main() -> int:
    args = parser().parse_args()
    return args.handler(args)


if __name__ == "__main__":
    sys.exit(main())
