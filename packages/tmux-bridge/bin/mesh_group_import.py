"""Deterministically convert explicit legacy graph conventions to group rows."""

from hashlib import sha256
import json
import re
from uuid import NAMESPACE_URL, uuid5


_SLUG = re.compile(r"[a-z0-9][a-z0-9_.-]{0,127}")
_UUID = r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
_SESSION = re.compile(rf"(?:codex|claude):{_UUID}")
_LINK_ID = re.compile(rf"link-{_UUID}")


def graph_import_plan(snapshot, source, role_bindings, include_groups=None):
    if not isinstance(source, str) or not _SLUG.fullmatch(source):
        raise ValueError("invalid graph source name")
    if include_groups is not None and (not isinstance(include_groups, list) or not include_groups
            or any(not isinstance(ref, str) or not ref.startswith("group:")
                   or not _SLUG.fullmatch(ref[6:]) for ref in include_groups)
            or len(set(include_groups)) != len(include_groups)):
        raise ValueError("group selection must contain unique legacy group references")
    if (not isinstance(snapshot, dict) or snapshot.get("schema") != "agent-mesh.session-graph.v1"
            or snapshot.get("migrated") is not True or not isinstance(snapshot.get("links"), list)):
        raise ValueError("expected a migrated Agent Mesh graph snapshot with links")
    observed_seq = snapshot.get("lastSeq")
    if snapshot.get("unnumbered", False) is not False or type(observed_seq) is not int or observed_seq < 1:
        raise ValueError("expected a numbered graph snapshot with complete link coverage")

    groups, areas = {}, {}
    from_groups, from_areas = set(), set()
    conflicts, ignored = set(), set()
    witnesses = {}
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
        witness = link.get("id")
        if not isinstance(witness, str) or not _LINK_ID.fullmatch(witness):
            conflicts.add(f"missing or invalid witness link ID for {ref}")
            continue
        if witness in witnesses:
            conflicts.add(f"duplicate witness link ID: {witness}")
            continue
        (groups if kind == "group" else areas).setdefault(ref, set()).add(session)
        evidence = link.get("evidence", [])
        if not isinstance(evidence, list) or not all(isinstance(item, str) for item in evidence):
            conflicts.add(f"invalid legacy evidence for {ref}")
            continue
        counterpart = "area" if kind == "group" else "group"
        matched_evidence = set()
        for item in evidence:
            if not item.startswith(f"{counterpart}:"):
                continue
            if not _SLUG.fullmatch(item.partition(":")[2]):
                conflicts.add(f"invalid legacy evidence reference for {ref}: {item}")
                continue
            matched_evidence.add(item)
            if kind == "group":
                from_groups.add((ref, item))
            else:
                from_areas.add((item, ref))
        witnesses[witness] = {"id": witness, "session": session, "ref": ref, "role": role,
                              "evidence": sorted(matched_evidence)}

    for group_ref, area_ref in from_groups ^ from_areas:
        conflicts.add(f"nonreciprocal group/area evidence: {group_ref} and {area_ref}")
    referenced_groups = {}
    for group_ref, area_ref in from_groups | from_areas:
        referenced_groups.setdefault(area_ref, set()).add(group_ref)
    ambiguous = {area_ref for area_ref, refs in referenced_groups.items() if len(refs) > 1}
    for area_ref in ambiguous:
        conflicts.add(f"more than one group is evidenced for {area_ref}: {', '.join(sorted(referenced_groups[area_ref]))}")
    reciprocal = {}
    for group_ref, area_ref in from_groups & from_areas:
        if area_ref not in ambiguous:
            reciprocal.setdefault(group_ref, []).append(area_ref)
    for ref in role_bindings.keys() - groups.keys():
        conflicts.add(f"role binding refers to a group absent from the import: {ref}")
    role_owners = {}
    for ref, role in role_bindings.items():
        role_owners.setdefault(role, []).append(ref)
    for role, refs in role_owners.items():
        if len(refs) > 1:
            conflicts.add(f"role {role} is bound to more than one group: {', '.join(sorted(refs))}")

    rows = []
    for ref, members in sorted(groups.items()):
        linked_areas = sorted(reciprocal.get(ref, ()))
        rows.append({"group_id": f"group_{uuid5(NAMESPACE_URL, f'urn:agent-mesh:plexus:{ref}').hex}",
                     "source_ref": ref, "name": ref.partition(":")[2], "role_key": role_bindings.get(ref),
                     "members": sorted(members),
                     "ledger_links": [{"ref": area, "lead": True} for area in linked_areas],
                     "area_owners": {area: sorted(areas[area]) for area in linked_areas}})
    for ref in areas.keys() - referenced_groups.keys():
        ignored.add(f"open ownership for {ref} has no group evidence")
    if not rows:
        conflicts.add("snapshot contains no importable legacy groups")
    selection = None if include_groups is None else sorted(include_groups)
    if selection is not None:
        for ref in set(selection) - groups.keys():
            conflicts.add(f"selected group absent from graph: {ref}")
        for ref in role_bindings.keys() - set(selection):
            conflicts.add(f"role binding refers to an unselected group: {ref}")
        rows = [row for row in rows if row["source_ref"] in selection]
    source_witnesses = [item for _, item in sorted(witnesses.items())
                        if item["role"] == "discusses" or item["ref"] in referenced_groups]
    plan = {"schema": "agent-mesh.group-import.v1", "source": source, "groups": rows,
            "source_witnesses": source_witnesses,
            "conflicts": sorted(conflicts), "ignored": sorted(ignored)}
    if selection is not None:
        plan["included_groups"] = selection
    canonical = json.dumps(plan, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return {**plan, "observed_source_seq": observed_seq,
            "plan_digest": sha256(canonical.encode("ascii")).hexdigest()}
