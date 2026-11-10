#!/usr/bin/env python3
"""Trusted local CLI for a single message to an Agent Mesh group."""
import argparse
import json
import os
import stat
from pathlib import Path
import sys

from mesh_group_dispatch import DispatchError, dispatch, native_transport
from mesh_group_store import GroupActor, GroupStore


def load_cloud_bindings(path):
    if path is None:
        return None
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--as-session", required=True, help="trusted local actor session")
    parser.add_argument("--group", required=True)
    parser.add_argument("--message-id", required=True)
    parser.add_argument("--to", action="append", required=True, help="member destination in fallback order")
    parser.add_argument("--managed-inbox-root", type=Path)
    parser.add_argument("--cloud-bindings", type=Path, help="private account-scope binding file")
    parser.add_argument("--timeout", type=int, default=45)
    args = parser.parse_args()
    if args.as_session.startswith(("claude-cloud:", "codex-cloud:")):
        parser.error("cloud actors need a separate authenticated adapter")
    if not 1 <= args.timeout <= 600:
        parser.error("timeout must be between 1 and 600 seconds")
    message = sys.stdin.read(128001)
    if len(message) > 128000:
        parser.error("message too large")
    try:
        bindings = load_cloud_bindings(args.cloud_bindings)
        transport = lambda destination, correlation, text: native_transport(
            destination, correlation, text, inbox_root=args.managed_inbox_root, timeout=args.timeout,
            cloud_bindings=bindings)
        result = dispatch(GroupStore(args.state), GroupActor(session_id=args.as_session), args.group,
                          args.message_id, message, args.to, transport)
    except (ValueError, OSError) as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 2
    print(json.dumps(result))
    return 0 if result["status"] in ("accepted", "held") else 1


if __name__ == "__main__":
    sys.exit(main())
