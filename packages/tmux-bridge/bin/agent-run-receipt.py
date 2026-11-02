#!/usr/bin/env python3
"""Record run receipts for unattended agent jobs and flag jobs that stopped running.

`record` appends one receipt per wake (cron, timer, inbox, relay) to a daily JSONL file.
`check` reads a watch list and reports, per job, whether its latest evidence is recent
enough. Evidence is either this tool's receipts or files a job already writes (a glob),
optionally matched against fields of the newest JSON file. The checker only reports:
it never restarts, kills, or reschedules anything.
"""

from __future__ import annotations

import argparse
import fcntl
import glob
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

SCHEMA = "agent-mesh.run-receipt.v1"
CHECK_SCHEMA = "agent-mesh.run-check.v1"
OUTCOMES = ("acted", "noop", "blocked", "failed")
TRIGGERS = ("cron", "timer", "inbox", "relay", "manual")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_time(value: str) -> datetime:
    moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def runs_dir() -> Path:
    explicit = os.environ.get("AGENT_RUNS_DIR")
    if explicit:
        return Path(explicit)
    state = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local/state")
    return Path(state) / "agent-runs"


def record(args: argparse.Namespace) -> int:
    ended = parse_time(args.ended_at) if args.ended_at else utcnow()
    receipt: dict[str, Any] = {
        "schema": SCHEMA,
        "job": args.job,
        "trigger": args.trigger,
        "outcome": args.outcome,
        "endedAt": iso(ended),
    }
    if args.started_at:
        receipt["startedAt"] = iso(parse_time(args.started_at))
    if args.session:
        receipt["session"] = args.session
    if args.note:
        receipt["note"] = args.note
    directory = runs_dir()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = directory / f"{ended.astimezone(timezone.utc):%Y-%m-%d}.jsonl"
    line = json.dumps(receipt, sort_keys=True) + "\n"
    # O_APPEND plus an exclusive lock keeps lines whole when two jobs end at once.
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        os.write(fd, line.encode())
        os.fsync(fd)
    finally:
        os.close(fd)
    print(line, end="")
    return 0


def latest_receipt(job: str, since: datetime) -> dict[str, Any] | None:
    directory = runs_dir()
    if not directory.is_dir():
        return None
    newest: dict[str, Any] | None = None
    for path in sorted(directory.glob("*.jsonl")):
        try:
            day = datetime.strptime(path.stem, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if day + timedelta(days=1) < since:
            continue
        for raw in path.read_text(errors="replace").splitlines():
            try:
                item = json.loads(raw)
                if item.get("schema") != SCHEMA or item.get("job") != job:
                    continue
                item["_at"] = parse_time(item["endedAt"])
            except (ValueError, KeyError, TypeError, AttributeError):
                continue
            if newest is None or item["_at"] >= newest["_at"]:
                newest = item
    return newest


def field(document: Any, dotted: str) -> Any:
    for part in dotted.split("."):
        if not isinstance(document, dict) or part not in document:
            return None
        document = document[part]
    return document


def check_job(job: dict[str, Any], now: datetime) -> dict[str, Any]:
    name = job["name"]
    max_age = timedelta(hours=float(job["maxAgeHours"]))
    result: dict[str, Any] = {"schema": CHECK_SCHEMA, "job": name, "checkedAt": iso(now),
                              "maxAgeHours": job["maxAgeHours"]}
    last: datetime | None = None
    if job.get("path"):
        matches = [Path(p) for p in glob.glob(os.path.expanduser(job["path"])) if Path(p).is_file()]
        result["evidence"] = "path"
        if matches:
            newest = max(matches, key=lambda p: p.stat().st_mtime)
            last = datetime.fromtimestamp(newest.stat().st_mtime, timezone.utc)
            result["latest"] = str(newest)
            expect = job.get("expect") or {}
            if expect:
                try:
                    document = json.loads(newest.read_text())
                except (OSError, ValueError):
                    document = None
                mismatches = {key: field(document, key) for key, want in expect.items()
                              if field(document, key) != want}
                if mismatches:
                    result["mismatch"] = mismatches
    else:
        result["evidence"] = "receipts"
        # Look back a little past the limit so an overdue job still shows its last run.
        receipt = latest_receipt(name, now - max_age * 2)
        if receipt:
            last = receipt["_at"]
            result["outcome"] = receipt.get("outcome")
    if last is None:
        result["status"] = "never"
        return result
    result["lastRunAt"] = iso(last)
    result["ageHours"] = round((now - last).total_seconds() / 3600, 2)
    if now - last > max_age:
        result["status"] = "missed"
    elif result.get("mismatch"):
        result["status"] = "unexpected"
    elif result.get("outcome") == "failed":
        result["status"] = "failed"
    else:
        result["status"] = "ok"
    return result


def check(args: argparse.Namespace) -> int:
    try:
        config = json.loads(Path(args.config).expanduser().read_text())
        jobs = config["jobs"]
        for job in jobs:
            if not job.get("name") or "maxAgeHours" not in job:
                raise ValueError("every job needs name and maxAgeHours")
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"agent-run-receipt: invalid watch list: {error}", file=sys.stderr)
        return 1
    now = parse_time(args.now) if args.now else utcnow()
    healthy = True
    for job in jobs:
        result = check_job(job, now)
        if result["status"] != "ok":
            healthy = False
        elif args.alerts_only:
            continue
        print(json.dumps(result, sort_keys=True))
    return 0 if healthy else 2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)

    rec = commands.add_parser("record", help="append one run receipt")
    rec.add_argument("--job", required=True)
    rec.add_argument("--outcome", required=True, choices=OUTCOMES)
    rec.add_argument("--trigger", default="manual", choices=TRIGGERS)
    rec.add_argument("--session")
    rec.add_argument("--started-at")
    rec.add_argument("--ended-at", help="defaults to now")
    rec.add_argument("--note")
    rec.set_defaults(func=record)

    chk = commands.add_parser("check", help="report jobs whose latest run is too old")
    chk.add_argument("--config", required=True, help="JSON watch list: {\"jobs\": [...]}")
    chk.add_argument("--now", help="evaluate as of this UTC time")
    chk.add_argument("--alerts-only", action="store_true", help="print only jobs that are not ok")
    chk.set_defaults(func=check)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
