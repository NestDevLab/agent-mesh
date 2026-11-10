"""Deterministically convert explicit legacy graph conventions to group rows."""

from hashlib import sha256
import json
import re
from uuid import NAMESPACE_URL, uuid5


_SLUG = re.compile(r"[a-z0-9][a-z0-9_.-]{0,127}")
_SESSION = re.compile(r"(?:codex|claude):[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")


def graph_import_plan(snapshot, source):
    if not isinstance(source, str) or not _SLUG.fullmatch(source):
        raise ValueError("invalid graph source name")
    if (not isinstance(snapshot, dict) or snapshot.get("schema") != "agent-mesh.session-graph.v1"
            or snapshot.get("migrated") is not True or not isinstance(snapshot.get("links"), list)):
        raise ValueError("expected a migrated Agent Mesh graph snapshot with links")

    groups, areas = {}, {}
    conflicts, ignored = set(), set()
    for link in snapshot["links"]:
        if not isinstance(link, dict) or not isinstance(link.get("ref"), str):
            raise ValueError("invalid graph link")
        ref = link["ref"]
        kind, _, slug = ref.partition(":")
        if kind not in {"group", "area"} or ":" not in ref:
            continue
        if "until" not in link or (link["until"] is not None and not isinstance(link["until"], str)):
            conflicts.add(f"missing or invalid closure status for {ref}")
            continue
        if link["until"] is not None:
            continue
        role = "discusses" if kind == "group" else "owns"
        if link.get("role") != role:
            ignored.add(f"open {ref} link without role {role}")
            continue
        if not _SLUG.fullmatch(slug):
            conflicts.add(f"invalid legacy slug for {ref}")
            continue
        session = link.get("session")
        if not isinstance(session, str) or not _SESSION.fullmatch(session):
            conflicts.add(f"unresolved or noncanonical session for {ref}")
            continue
        (groups if kind == "group" else areas).setdefault(slug, set()).add(session)

    rows = []
    for slug, members in sorted(groups.items()):
        ref = f"group:{slug}"
        rows.append({"group_id": f"group_{uuid5(NAMESPACE_URL, f'urn:agent-mesh:plexus:{ref}').hex}",
                     "source_ref": ref, "name": slug, "members": sorted(members),
                     "ledger_links": [{"ref": f"area:{slug}", "lead": True}] if slug in areas else [],
                     "area_owners": sorted(areas.get(slug, ()))})
    for slug in sorted(areas.keys() - groups.keys()):
        ignored.add(f"open ownership for area:{slug} has no matching legacy group")
    if not rows:
        conflicts.add("snapshot contains no importable legacy groups")
    plan = {"schema": "agent-mesh.group-import.v1", "source": source, "groups": rows,
            "conflicts": sorted(conflicts), "ignored": sorted(ignored)}
    canonical = json.dumps(plan, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return {**plan, "plan_digest": sha256(canonical.encode("ascii")).hexdigest()}
