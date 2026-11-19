#!/usr/bin/env python3
"""Persist a manual session restart checkpoint and its ordered receipts."""

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hmac
import json
import os
from pathlib import Path
import secrets
import stat
import sys
import tempfile
import uuid


SCHEMA = "agent-mesh.manual-sleep.v1"
SECTIONS = ("work", "decisions", "nextSteps", "references")
MAX_CHECKPOINT = 64 * 1024


def session(value):
    runtime, separator, identifier = value.partition(":")
    if not separator or runtime not in ("claude", "codex"):
        raise ValueError("session must be claude:<uuid> or codex:<uuid>")
    if str(uuid.UUID(identifier)) != identifier:
        raise ValueError("session UUID must be canonical")
    return runtime


def private_root(create=False):
    state_home = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local/state")
    if not state_home.is_absolute():
        raise ValueError("XDG_STATE_HOME must be absolute")
    root = state_home / "agent-mesh" / "manual-sleep"
    if create:
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
    metadata = root.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
        raise ValueError("manual sleep state directory must be private and owned by this user")
    return root


@contextmanager
def store(create):
    root = private_root(create)
    flags = os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK
    if create:
        flags |= os.O_CREAT
    with os.fdopen(os.open(root / ".lock", flags, 0o600), "rb+") as lock:
        metadata = os.fstat(lock.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
            raise ValueError("manual sleep lock must be a private regular file")
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield root


def read_record(path):
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
        raise ValueError("checkpoint must be a private regular file owned by this user")
    record = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(record, dict) or record.get("schema") != SCHEMA or record.get("operation") != path.stem:
        raise ValueError("checkpoint schema or operation does not match")
    return record


def save(path, record):
    # Readers see the old or new receipt even if the process stops mid-write.
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            json.dump(record, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
            os.replace(temporary, path)
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            temporary.unlink(missing_ok=True)


def note(record, outcome, **details):
    record["receipts"].append({
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "outcome": outcome,
        **details,
    })


def status(record):
    return record["receipts"][-1]["outcome"]


def closed(record):
    return status(record) in ("aborted", "archived") or (
        record["runtime"] == "claude" and status(record) == "resumed"
    )


def prepare(args, root):
    runtime = session(args.source)
    cwd = Path(args.cwd).resolve(strict=True)
    if not cwd.is_dir() or not Path(args.cwd).is_absolute():
        raise ValueError("checkpoint cwd must be an existing absolute directory")
    raw = sys.stdin.buffer.read(MAX_CHECKPOINT + 1)
    if len(raw) > MAX_CHECKPOINT:
        raise ValueError("checkpoint exceeds 64 KiB")
    checkpoint = json.loads(raw)
    if not isinstance(checkpoint, dict) or set(checkpoint) != set(SECTIONS):
        raise ValueError("checkpoint requires work, decisions, nextSteps and references")
    for section in SECTIONS:
        values = checkpoint[section]
        if not isinstance(values, list) or not all(isinstance(value, str) and value.strip() for value in values):
            raise ValueError(f"{section} must be an array of nonempty strings")
    if not checkpoint["work"] or not checkpoint["nextSteps"]:
        raise ValueError("work and nextSteps must include at least one entry")
    for path in root.glob("*.json"):
        existing = read_record(path)
        if existing["source"] == args.source and not closed(existing):
            raise ValueError(f"source already has an open attempt: {path.stem}")
    operation = str(uuid.uuid4())
    record = {
        "schema": SCHEMA,
        "operation": operation,
        "source": args.source,
        "runtime": runtime,
        "cwd": str(cwd),
        "mode": args.mode,
        "checkpoint": checkpoint,
        "resumeToken": secrets.token_hex(16),
        "receipts": [],
    }
    note(record, "prepared")
    path = root / f"{operation}.json"
    save(path, record)
    return path, record


def advance(args, record):
    current = status(record)
    command = args.command
    if command == "begin" and current == "prepared":
        note(record, "started", surface=args.surface)
    elif command == "uncertain" and current in ("started", "uncertain"):
        note(record, "uncertain", evidence=args.evidence)
    elif command == "abort" and current in ("prepared", "started", "uncertain"):
        note(record, "aborted", evidence=args.evidence)
    elif command == "resume" and current in ("started", "uncertain"):
        runtime = session(args.session)
        started = next(item for item in record["receipts"] if item["outcome"] == "started")
        if runtime != record["runtime"] or args.surface != started["surface"]:
            raise ValueError("resume must match the runtime and surface reserved at begin")
        if Path(args.cwd).resolve(strict=True) != Path(record["cwd"]):
            raise ValueError("resume must match the checkpoint cwd")
        if runtime == "codex" and args.session == record["source"]:
            raise ValueError("Codex must resume in a different native thread")
        if not hmac.compare_digest(args.token, record["resumeToken"]):
            raise ValueError("resume acknowledgment did not match this checkpoint")
        note(record, "resumed", session=args.session, evidence=args.evidence)
    elif command == "link" and record["runtime"] == "codex" and current == "resumed":
        successor = record["receipts"][-1]["session"].split(":", 1)[1]
        note(record, "linked", link=f"codex://threads/{successor}", evidence=args.evidence)
    elif command == "archive" and record["runtime"] == "codex" and current == "linked":
        note(record, "archived", evidence=args.evidence)
    else:
        raise ValueError(f"cannot {command} a {record['runtime']} attempt in state {current}")


def bounded(value):
    if not value.strip() or len(value) > 1024 or any(c in value for c in "\r\n\x00"):
        raise argparse.ArgumentTypeError("expected a nonempty line of at most 1024 characters")
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    new = sub.add_parser("prepare")
    new.add_argument("--source", required=True)
    new.add_argument("--cwd", required=True)
    new.add_argument("--mode", choices=("sleep", "nap"), default="sleep")
    for action in ("read", "begin", "resume", "uncertain", "abort", "link", "archive"):
        step = sub.add_parser(action)
        step.add_argument("operation")
        if action in ("begin", "resume"):
            step.add_argument("--surface", required=True, type=bounded)
        if action in ("resume", "uncertain", "abort", "link", "archive"):
            step.add_argument("--evidence", required=True, type=bounded)
        if action == "resume":
            step.add_argument("--session", required=True)
            step.add_argument("--cwd", required=True)
            step.add_argument("--token", required=True)
    args = parser.parse_args()

    try:
        with store(create=args.command == "prepare") as root:
            if args.command == "prepare":
                path, record = prepare(args, root)
            else:
                operation = str(uuid.UUID(args.operation))
                if operation != args.operation:
                    raise ValueError("operation UUID must be canonical")
                path = root / f"{operation}.json"
                record = read_record(path)
                if args.command != "read":
                    advance(args, record)
                    save(path, record)
        output = record if args.command == "read" else {
            "operation": record["operation"], "stateFile": str(path), "receipt": record["receipts"][-1],
        }
        print(json.dumps(output, ensure_ascii=False))
    except (OSError, TypeError, ValueError) as error:
        print(f"session-sleep: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
