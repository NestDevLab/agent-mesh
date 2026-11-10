#!/usr/bin/env python3
"""Linux graph lock gate; all writers sharing a store must use this protocol."""

import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import time
from uuid import uuid4

WAIT_SECONDS = 5.0
STALE_SECONDS = 60.0


def namespace():
    return {"boot": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
            "pidns": os.readlink("/proc/self/ns/pid")}


def process_info(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
        return {"state": fields[0], "start": fields[19]}
    except FileNotFoundError:
        return None


def record(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, "rb") as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ValueError("graph lock metadata is not private")
        payload = file.read(4097)
    if len(payload) > 4096:
        raise ValueError("graph lock metadata is too large")
    value = json.loads(payload)
    return value if isinstance(value, dict) else None


def identity_dead(identity, current_namespace):
    if (not isinstance(identity, dict) or type(identity.get("pid")) is not int
            or identity["pid"] <= 1 or not isinstance(identity.get("start"), str)
            or identity.get("boot") != current_namespace["boot"]
            or identity.get("pidns") != current_namespace["pidns"]):
        return False
    info = process_info(identity["pid"])
    return info is None or info["start"] != identity["start"] or info["state"] == "Z"


@contextmanager
def gate(root):
    info = root.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise ValueError("graph state directory must be owned and not writable by others")
    fd = os.open(root / "graph.lock.gate", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_nlink != 1:
            raise ValueError("graph lock gate must be private and owned")
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def reclaimable(lock, current_namespace):
    try:
        if time.time() - lock.stat().st_mtime <= STALE_SECONDS:
            return False
        owner = record(lock / "owner.json")
        if not identity_dead(owner, current_namespace):
            return False
        guard = record(lock / "comms-guard.json")
        if guard is None:
            return True
        # Other role-run children may outlive their guard. Only a registered
        # live-import worker has parent-death protection and can be qualified.
        worker = record(lock / "import-worker.json")
        return (isinstance(worker, dict) and guard.get("pid") == owner["pid"]
                and guard.get("start") == owner["start"]
                and worker.get("guard_pid") == owner["pid"]
                and worker.get("guard_start") == owner["start"]
                and isinstance(guard.get("tokenHash"), str)
                and worker.get("tokenHash") == guard["tokenHash"]
                and identity_dead(worker, current_namespace))
    except (OSError, ValueError, IndexError, json.JSONDecodeError):
        return False


def acquire(root, pid):
    current_namespace = namespace()
    info = process_info(pid)
    if info is None or info["state"] == "Z":
        raise ValueError("graph lock owner is not alive")
    token = uuid4().hex
    owner = {"pid": pid, "start": info["start"], **current_namespace, "token": token}
    deadline = time.monotonic() + WAIT_SECONDS
    lock = root / "graph.lock"
    while True:
        with gate(root):
            if lock.exists() and reclaimable(lock, current_namespace):
                shutil.rmtree(lock)
            try:
                lock.mkdir(mode=0o700)
            except FileExistsError:
                pass
            else:
                # A crash between mkdir and this write leaves an unmarked lock
                # which is never reaped automatically.
                fd = os.open(lock / "owner.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, "w") as file:
                    json.dump(owner, file)
                    file.flush()
                    os.fsync(file.fileno())
                return token
        if time.monotonic() >= deadline:
            raise ValueError("graph is busy or lock ownership is uncertain")
        time.sleep(.025)


def release(root, pid, token):
    with gate(root):
        lock = root / "graph.lock"
        owner = record(lock / "owner.json")
        if not owner or owner.get("pid") != pid or owner.get("token") != token:
            raise ValueError("graph lock ownership changed; refusing release")
        shutil.rmtree(lock)


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("operation", choices=("acquire", "release"))
    cli.add_argument("--state", required=True, type=Path)
    cli.add_argument("--pid", required=True, type=int)
    cli.add_argument("--token")
    args = cli.parse_args()
    if sys.platform != "linux":
        raise ValueError("Linux graph lock protocol required")
    root = args.state.resolve(strict=True)
    if args.operation == "acquire":
        print(json.dumps({"token": acquire(root, args.pid)}))
    else:
        if not args.token:
            raise ValueError("release token required")
        release(root, args.pid, args.token)
        print(json.dumps({"released": True}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, IndexError, json.JSONDecodeError) as error:
        print(f"graph lock: {error}", file=sys.stderr)
        sys.exit(1)
