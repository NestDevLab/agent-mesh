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
from mesh_group_store import GroupAccessError, GroupActor, GroupStore


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


def read_group_metadata(refs, *, ledger_refs, state=None):
    """Read only explicitly granted group records and their granted item links."""
    if not isinstance(refs, list) or not isinstance(ledger_refs, list):
        raise ValueError("group metadata requires exact grant lists")
    store = GroupStore(state or default_state_dir())
    actor = GroupActor(manage=True)
    permitted = set(ledger_refs)
    groups, missing = {}, []
    for ref in sorted(set(refs)):
        if not isinstance(ref, str) or not ref.startswith("group:"):
            raise ValueError("invalid group metadata grant")
        if ref.startswith("group:group_"):
            try:
                found = [store.get_group(actor, ref.split(":", 1)[1])]
            except GroupAccessError:
                found = []
        else:
            found = store.list_groups(actor, source_ref=ref)
        if not found:
            missing.append(ref)
        for group in found:
            groups[group["group_id"]] = {
                key: group[key] for key in ("group_id", "name", "role_key", "source_ref")
            }
            groups[group["group_id"]]["ledger_links"] = [
                link for link in group["ledger_links"] if link["ref"] in permitted
            ]
    return {"groups": [groups[key] for key in sorted(groups)], "missing": missing}


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


def assignment_inputs(session=None):
    """Read the authoritative graph/catalog and exact source-owned item metadata."""
    directory = Path(__file__).resolve().parent
    def run(command):
        result = subprocess.run(command, capture_output=True, text=True, timeout=120, check=False)
        if result.returncode:
            raise ValueError("membership input query failed: " + result.stderr.strip()[:300])
        return json.loads(result.stdout)
    graph_args = ["--state", os.environ["MESH_GRAPH_STATE"]] if os.environ.get("MESH_GRAPH_STATE") else []
    graph = run(["node", str(directory / "mesh-graph.mjs"), "show", "--json", *graph_args])
    catalog = run(["node", str(directory / "mesh-graph.mjs"), "catalog", "list", "--archive", "include", *graph_args])
    sessions = {row["sessionId"]: row for row in catalog["sessions"]}
    def identity(node):
        cloud = node.get("cloudIdentity")
        if cloud:
            return ":".join(cloud[key] for key in ("provider", "accountScope", "nativeId"))
        return f"{node.get('agent')}:{node.get('runtimeUuid', '').lower()}"
    by_node = {node["id"]: identity(node) for node in graph["nodes"]}
    parents = {}
    for edge in graph.get("edges", []):
        if edge.get("type") == "spawned-by" and not edge.get("until"):
            parents.setdefault(by_node.get(edge["to"]), set()).add(by_node.get(edge["from"]))
    for node in graph["nodes"]:
        key = identity(node)
        if key not in sessions:
            continue
        sessions[key].setdefault("domains", []).extend(node.get("domains", []))
        for launch in node.get("launches", []):
            if launch.get("kind") == "spawn" and launch.get("caller"):
                matches = [sid for sid in sessions if sid == launch["caller"] or sid.split(":", 1)[1] == launch["caller"]]
                if len(matches) == 1:
                    parents.setdefault(key, set()).add(matches[0])
    # Native spawn edges also cover children created outside the tmux bridge.
    native = Path(os.environ.get("CODEX_STATE_DB", Path.home() / ".codex" / "state_5.sqlite"))
    if native.exists():
        with sqlite3.connect(native.absolute().as_uri() + "?mode=ro", uri=True) as db:
            if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_spawn_edges'").fetchone():
                for parent, child in db.execute("SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges"):
                    parents.setdefault("codex:" + child.lower(), set()).add("codex:" + parent.lower())
    for key, values in parents.items():
        if key in sessions and len(values) == 1 and None not in values:
            sessions[key]["parent"] = next(iter(values))
    links = graph.get("links", [])
    refs = sorted({link["ref"] for link in links if (session is None or link.get("session") == session)
                   and link.get("until") is None and link.get("role") in {"owns", "works-on"}
                   and link["ref"].split(":", 1)[0] not in {"area", "group", "session-link"}})
    items = {}
    if refs:
        data = run([sys.executable, str(directory / "mesh-ledger.py"), "query", "--refs", *refs, "--json"])
        if data.get("errors"):
            raise ValueError("membership ledger query returned errors")
        items = {row["ref"]: row for row in data["items"]}
    return sessions, links, items


def parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--state", help="Override the local group database directory")
    common.add_argument("--as-session", metavar="SESSION_ID",
                        help="Attest a local session identity from this trusted local account")
    common.add_argument("--json", action="store_true", help="Emit JSON (the default)")
    cli = argparse.ArgumentParser(prog="agent-mesh group", description=__doc__)
    sub = cli.add_subparsers(dest="command", required=True)

    for command in ("ensure", "reconcile"):
        assignment = sub.add_parser(command, parents=[common], help="Ensure mandatory group membership")
        assignment.add_argument("--apply", action="store_true", help="Apply assignments (default: preview)")
        if command == "ensure":
            assignment.add_argument("--session", required=True)

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
    if args.command in {"ensure", "reconcile"}:
        if not actor.manage:
            raise ValueError("group management is not authorized")
        sessions, links, items = assignment_inputs(getattr(args, "session", None))
        if args.command == "ensure":
            return store.ensure_membership(actor, args.session, sessions, links, items, apply=args.apply)
        return store.reconcile_membership(actor, sessions, links, items, apply=args.apply)
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
        result = dispatch(parser().parse_args())
        print(json.dumps(result, ensure_ascii=True))
        if result.get("errors"):
            sys.exit(1)
    except (ValueError, OSError, sqlite3.Error, subprocess.TimeoutExpired) as error:
        print(f"agent-mesh group: {error}", file=sys.stderr)
        sys.exit(1)
