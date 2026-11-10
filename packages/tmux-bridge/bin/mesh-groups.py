#!/usr/bin/env python3
"""Trusted local CLI for the Agent Mesh group API."""

import argparse
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys

sys.dont_write_bytecode = True
from mesh_group_store import GroupActor, GroupStore


MAX_GRAPH_BYTES = 32 * 1024 * 1024
MAX_ROLE_MAP_BYTES = 64 * 1024


def read_json(path, limit):
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON key in import input")
            result[key] = value
        return result

    with path.open("rb") as file:
        payload = file.read(limit + 1)
    if len(payload) > limit:
        raise ValueError(f"import input exceeds {limit} bytes")
    return json.loads(payload, object_pairs_hook=unique_object)


def default_state_dir():
    state_home = os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state"
    return os.environ.get("MESH_GROUPS_STATE") or Path(state_home) / "agent-mesh" / "groups"


def is_cloud_session(session_id):
    return bool(session_id and session_id.partition(":")[0].endswith("-cloud"))


def require_cloud_registration(session_id):
    graph = Path(__file__).with_name("mesh-graph.mjs")
    try:
        result = subprocess.run(
            ["node", str(graph), "cloud", "get", "--session", session_id],
            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10, check=False,
        )
        if result.returncode == 0:
            found = json.loads(result.stdout)
            if isinstance(found, dict) and found.get("sessionId") == session_id:
                return
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    raise ValueError("an open cloud graph registration is required")


def parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--state", help="Override the local group database directory")
    common.add_argument("--as-session", metavar="SESSION_ID",
                        help="Attest a local session identity from this trusted local account")
    common.add_argument("--json", action="store_true", help="Emit JSON (the default)")
    cli = argparse.ArgumentParser(prog="agent-mesh group", description=__doc__)
    sub = cli.add_subparsers(dest="command", required=True)

    create = sub.add_parser("create", parents=[common], help="Create a group")
    create.add_argument("name")
    create.add_argument("--role", metavar="ROLE_KEY")

    listing = sub.add_parser("list", parents=[common], help="List accessible groups")
    listing.add_argument("--ledger-ref")
    listing.add_argument("--source-ref", help="Filter on the exact imported legacy group reference")
    sub.add_parser("get", parents=[common], help="Show one accessible group").add_argument("group_id")

    for command in ("add", "remove"):
        membership = sub.add_parser(command, parents=[common], help=f"{command.title()} a group member")
        membership.add_argument("group_id")
        membership.add_argument("session_id")

    route = sub.add_parser("set-route", parents=[common], help="Set ordered primary and fallback members")
    route.add_argument("group_id")
    route.add_argument("--revision", type=int, required=True)
    choice = route.add_mutually_exclusive_group(required=True)
    choice.add_argument("--to", action="append", help="Member in primary/fallback order; repeat for each member")
    choice.add_argument("--clear", action="store_true", help="Clear the route while preserving its revision")

    link = sub.add_parser("link", parents=[common], help="Link a ledger reference")
    link.add_argument("group_id")
    link.add_argument("ledger_ref")
    lead = link.add_mutually_exclusive_group()
    lead.add_argument("--lead", dest="lead", action="store_const", const=True, help="Assign the currently vacant lead")
    lead.add_argument("--clear-lead", dest="lead", action="store_const", const=False, help="Clear this link's lead")

    unlink = sub.add_parser("unlink", parents=[common], help="Unlink a ledger reference")
    unlink.add_argument("group_id")
    unlink.add_argument("ledger_ref")

    transfer = sub.add_parser("transfer-lead", parents=[common], help="Move an exact ledger lead atomically")
    transfer.add_argument("ledger_ref")
    transfer.add_argument("--from-group", required=True)
    transfer.add_argument("--to-group", required=True)

    append = sub.add_parser("append", parents=[common], help="Append a group message from stdin")
    append.add_argument("group_id")
    append.add_argument("--message-id", help="Repeat this id to safely retry the same message")

    history = sub.add_parser("history", parents=[common], help="Read group messages in sequence order")
    history.add_argument("group_id")
    history.add_argument("--after", type=int, default=0)
    history.add_argument("--limit", type=int, default=50)

    graph = sub.add_parser("import-graph", parents=[common], help="Preview an explicit legacy graph snapshot import")
    graph.add_argument("--snapshot", required=True, type=Path)
    graph.add_argument("--source", required=True, help="Stable name for the source graph")
    graph.add_argument("--role-map", type=Path, help="JSON object mapping legacy group refs to role keys")
    graph.add_argument("--apply", action="store_true")
    graph.add_argument("--plan-digest")
    return cli


def dispatch(args):
    store = GroupStore(args.state or default_state_dir())
    if is_cloud_session(args.as_session):
        raise ValueError("cloud session actors require an authenticated adapter")
    actor = GroupActor(session_id=args.as_session, manage=args.as_session is None)
    if args.command == "create":
        return store.create_group(actor, args.name, role_key=args.role)
    if args.command == "list":
        return {"groups": store.list_groups(actor, ledger_ref=args.ledger_ref, source_ref=args.source_ref)}
    if args.command == "get":
        return store.get_group(actor, args.group_id)
    if args.command == "add":
        if actor.manage and is_cloud_session(args.session_id):
            require_cloud_registration(args.session_id)
        return store.add_member(actor, args.group_id, args.session_id)
    if args.command == "remove":
        return store.remove_member(actor, args.group_id, args.session_id)
    if args.command == "set-route":
        return store.set_route(actor, args.group_id, [] if args.clear else args.to, args.revision)
    if args.command == "link":
        return store.link_ledger(actor, args.group_id, args.ledger_ref, lead=args.lead)
    if args.command == "unlink":
        return store.unlink_ledger(actor, args.group_id, args.ledger_ref)
    if args.command == "transfer-lead":
        return store.transfer_ledger_lead(actor, args.ledger_ref, from_group_id=args.from_group,
                                          to_group_id=args.to_group)
    if args.command == "append":
        if actor.session_id is None:
            raise ValueError("append requires --as-session")
        return store.append_message(actor, args.group_id, sys.stdin.read(32_001), message_id=args.message_id)
    if args.command == "history":
        return store.history(actor, args.group_id, after=args.after, limit=args.limit)
    if args.command == "import-graph":
        if not actor.manage:
            raise ValueError("group management is not authorized")
        if args.apply != (args.plan_digest is not None):
            raise ValueError("--apply and --plan-digest must be provided together")
        snapshot = read_json(args.snapshot, MAX_GRAPH_BYTES)
        role_bindings = read_json(args.role_map, MAX_ROLE_MAP_BYTES) if args.role_map is not None else {}
        if not isinstance(role_bindings, dict):
            raise ValueError("role bindings must map source refs to role keys")
        return store.import_graph(actor, snapshot, args.source, role_bindings=role_bindings,
                                  expected_digest=args.plan_digest)
    raise ValueError("unknown group command")


if __name__ == "__main__":
    try:
        print(json.dumps(dispatch(parser().parse_args()), ensure_ascii=True))
    except (ValueError, OSError, sqlite3.Error) as error:
        print(f"agent-mesh group: {error}", file=sys.stderr)
        sys.exit(1)
