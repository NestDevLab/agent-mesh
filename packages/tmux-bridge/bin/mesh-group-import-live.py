#!/usr/bin/env python3
"""Import a reviewed group snapshot under an existing local graph role guard."""

import argparse
import ctypes
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import sys

sys.dont_write_bytecode = True
from mesh_group_store import GroupActor, GroupStore

MAX_GRAPH_BYTES = 32 * 1024 * 1024
MAX_ROLE_MAP_BYTES = 64 * 1024
GRAPH = Path(__file__).resolve().with_name("mesh-graph.mjs")


def strict_json(payload, maximum):
    if len(payload) > maximum:
        raise ValueError("input exceeds its size limit")

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON input key")
            result[key] = value
        return result
    return json.loads(payload, object_pairs_hook=unique)


def process_start(pid):
    # Linux /proc stat field 22; the parenthesized command can contain spaces.
    return Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()[19]


def arm_parent_death_guard(graph_state):
    """Bind this single writer to the graph-lock owner before any store access."""
    if sys.platform != "linux":
        raise ValueError("live import requires Linux parent-death protection")
    raw_pid = os.environ.get("PROJECT_DIRECTOR_GUARD_PID", "")
    claim = os.environ.get("PROJECT_DIRECTOR_GUARD_CLAIM", "")
    token = os.environ.get("MESH_COMMS_GUARD_TOKEN", "")
    if not raw_pid.isdecimal() or not claim or not token:
        raise ValueError("live import must run under a graph role guard")
    parent = int(raw_pid)
    if parent <= 1 or os.getppid() != parent:
        raise ValueError("graph guard parent is no longer active")
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
        raise ValueError("cannot enable parent-death protection")
    if os.getppid() != parent:
        raise ValueError("graph guard parent changed while arming protection")
    proof = strict_json((graph_state / "graph.lock" / "comms-guard.json").read_bytes(), 4096)
    if (not isinstance(proof, dict) or proof.get("pid") != parent or proof.get("claim") != claim
            or proof.get("start") != process_start(parent)
            or not isinstance(proof.get("tokenHash"), str)
            or not hmac.compare_digest(proof["tokenHash"], hashlib.sha256(token.encode()).hexdigest())):
        raise ValueError("graph role guard proof is invalid")
    worker = {"pid": os.getpid(), "start": process_start(os.getpid()),
              "boot": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
              "pidns": os.readlink("/proc/self/ns/pid"), "guard_pid": parent,
              "guard_start": proof["start"], "tokenHash": proof["tokenHash"]}
    fd = os.open(graph_state / "graph.lock" / "import-worker.json",
                 os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as file:
        json.dump(worker, file)
        file.flush()
        os.fsync(file.fileno())


def parser():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--graph-state", type=Path, required=True)
    cli.add_argument("--state", type=Path, required=True, help="Group database directory")
    cli.add_argument("--session", required=True, help="Session holding the graph role claim")
    cli.add_argument("--role", required=True)
    cli.add_argument("--project", required=True)
    cli.add_argument("--claim-id", required=True)
    cli.add_argument("--source", required=True)
    cli.add_argument("--role-map", type=Path)
    cli.add_argument("--include-group", action="append", dest="include_groups")
    cli.add_argument("--apply", action="store_true")
    cli.add_argument("--plan-digest")
    cli.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    return cli


def run(args):
    if not args.graph_state.is_absolute() or not args.state.is_absolute():
        raise ValueError("graph and group state paths must be absolute")
    graph_state = args.graph_state.resolve(strict=True)
    group_state = args.state.resolve()
    if graph_state == group_state:
        raise ValueError("graph and group state directories must differ")
    if args.apply != (args.plan_digest is not None):
        raise ValueError("--apply and --plan-digest must be provided together")
    if args.plan_digest is not None and not re.fullmatch(r"[0-9a-f]{64}", args.plan_digest):
        raise ValueError("invalid plan digest")
    if args.worker:
        arm_parent_death_guard(graph_state)
        role_bindings = strict_json(args.role_map.read_bytes(), MAX_ROLE_MAP_BYTES) if args.role_map else {}
        if not isinstance(role_bindings, dict):
            raise ValueError("role bindings must be an object")
        observed = subprocess.run(
            ["node", str(GRAPH), "--state", str(graph_state), "show", "--json"],
            stdin=subprocess.DEVNULL, capture_output=True, timeout=15, check=False,
        )
        if observed.returncode:
            raise ValueError("cannot read the guarded graph")
        snapshot = strict_json(observed.stdout, MAX_GRAPH_BYTES)
        return GroupStore(group_state).import_graph(
            GroupActor(manage=True), snapshot, args.source, role_bindings=role_bindings,
            include_groups=args.include_groups, expected_digest=args.plan_digest,
        )
    if sys.platform != "linux":
        raise ValueError("live import requires Linux parent-death protection")
    # The child receives the same arguments, but only a real role-run parent
    # can supply the guard proof needed to enter the worker path.
    payload = json.dumps({"argv": [sys.executable, str(Path(__file__).resolve()), *sys.argv[1:], "--worker"]})
    command = ["node", str(GRAPH), "--state", str(graph_state), "role", "run",
               "--session", args.session, "--role", args.role, "--project", args.project,
               "--claim-id", args.claim_id, "--input", "-"]
    try:
        completed = subprocess.run(command, input=payload, capture_output=True, text=True,
                                   timeout=35, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise ValueError("guard outcome unknown; inspect the destination before retrying") from None
    if completed.returncode:
        raise ValueError("guard did not confirm the outcome; inspect destination before retrying: "
                         + completed.stderr.strip()[:512])
    return strict_json(completed.stdout.encode(), MAX_GRAPH_BYTES)


if __name__ == "__main__":
    try:
        print(json.dumps(run(parser().parse_args()), ensure_ascii=True))
    except (ValueError, OSError, sqlite3.Error, subprocess.TimeoutExpired, IndexError) as error:
        print(f"group live import: {error}", file=sys.stderr)
        sys.exit(1)
