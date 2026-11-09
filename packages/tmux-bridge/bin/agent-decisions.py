#!/usr/bin/env python3
"""Pure decision cards and calendar reminders for normalized work-item adapters.

No source reads, delivery, persistence or option execution occurs here. Callers
persist the returned state only after delivery acknowledgement. State is a map
of ref -> {hash, lastEmission, nextDue, reminderCount}; absence from a delta
never closes a ref. Pass closed_refs explicitly to select_due/forget_closed.
"""
from __future__ import annotations

from datetime import datetime, time, timedelta, timezone as dt_timezone
import hashlib
import json
import re
from zoneinfo import ZoneInfo
from urllib.parse import urlsplit


WAITING_STATUSES = frozenset({"waiting", "blocked"})
DEFAULT_LABELS = {"recommended": "Recommended", "continue": "Use source sentence", "open": "Open source", "discuss": "Discuss at source", "fallback": "Local source fallback",
                  "other": "Other: I'll write it", "discussConsequence": "Nothing moves until you've talked it through", "otherConsequence": "You answer in your own words"}
REQUEST_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,79}")
RESERVED_OPTIONS = frozenset({"discuss", "other"})
MAX_REAL_OPTIONS = 2


def _text(value):
    return isinstance(value, str) and bool(value.strip())


def _instant(value):
    result = value if isinstance(value, datetime) else datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("timestamps must include a timezone")
    return result.astimezone(dt_timezone.utc)


def _stamp(value):
    return value.astimezone(dt_timezone.utc).isoformat().replace("+00:00", "Z")


def make_decision(item, *, project=None, where=None, guard_sentence=None,
                  labels=None, question_template="{ask}", waiting_statuses=WAITING_STATUSES):
    """Return a card, or None unless the adapter explicitly names a human wait.

    Required input: ref, title, status, updatedAt. waitingOn.who must be human,
    its ask nonempty, and status an explicit waiting status. Hosts may configure
    their status vocabulary. updatedAt is validated but never hashed.
    resumeCondition (or a caller's exact guard_sentence) is copied verbatim.
    With neither, sourceGap is true and the recommended action only opens the
    source. No approval text is synthesized. A source location is required.
    Labels and the question template are presentation-only host configuration.
    """
    for key in ("ref", "title", "status", "updatedAt"):
        if not _text(item.get(key)):
            raise ValueError(f"missing required field: {key}")
    _instant(item["updatedAt"])
    waiting = item.get("waitingOn") or {}
    if item["status"] not in waiting_statuses or waiting.get("who") != "human" or not _text(waiting.get("ask")):
        return None
    location = where if _text(where) else item.get("url")
    if not _text(location):
        raise ValueError("human decision requires a source location")
    wording = {**DEFAULT_LABELS, **(labels or {})}
    sentence = item.get("resumeCondition")
    if not _text(sentence):
        sentence = guard_sentence if _text(guard_sentence) else None
    question = " ".join(question_template.format(ask=waiting["ask"], title=item["title"], ref=item["ref"]).split())
    if not question:
        raise ValueError("decision question must be nonempty")
    recommended = {
        "label": wording["continue"] if sentence else wording["open"],
        "recommended": True,
        "marker": wording["recommended"],
        "action": {"kind": "source-sentence", "value": sentence} if sentence else {"kind": "open-source", "value": location},
    }
    card = {
        "id": item["ref"], "project": project if project is not None else item.get("domain"),
        "question": question, "options": [recommended, {
            "label": wording["discuss"], "recommended": False,
            "action": {"kind": "discuss-at-source", "value": location},
        }], "discuss": True, "where": location, "sourceGap": sentence is None,
    }
    if not urlsplit(location).scheme:
        card.update(whereFallback=True, whereKind="local-source-fallback", whereLabel=wording["fallback"])
    return card


def make_request_card(request, *, labels=None):
    """Return a card from a session's own options, plus the discuss and write-in exits.

    Required: id, question, where, waitingSince and one or two options, each with
    id, label and consequence. Exactly one option is recommended, with a reason.
    Answers match on option id, never on the label.
    """
    if not isinstance(request, dict):
        raise ValueError("a decision request must be an object")
    if not isinstance(request.get("id"), str) or not REQUEST_ID.fullmatch(request["id"]):
        raise ValueError("decision id must be 1-80 safe characters")
    for key in ("question", "where", "waitingSince"):
        if not _text(request.get(key)):
            raise ValueError(f"missing required field: {key}")
    waiting_since = _stamp(_instant(request["waitingSince"]))
    options = request.get("options")
    if not isinstance(options, list) or not 1 <= len(options) <= MAX_REAL_OPTIONS:
        raise ValueError(f"a decision needs 1 to {MAX_REAL_OPTIONS} real options")
    for option in options:
        if not isinstance(option, dict):
            raise ValueError("each option must be an object")
        for key in ("id", "label", "consequence"):
            if not _text(option.get(key)):
                raise ValueError(f"option missing required field: {key}")
        if not REQUEST_ID.fullmatch(option["id"]):
            raise ValueError("option id must be 1-80 safe characters")
        if option["id"] in RESERVED_OPTIONS:
            raise ValueError(f"reserved option id: {option['id']}")
    if len({option["id"] for option in options}) != len(options):
        raise ValueError("option ids must be unique")
    picks = [option for option in options if option.get("recommended") is True]
    if len(picks) != 1 or not _text(picks[0].get("reason")):
        raise ValueError("exactly one option must be recommended, with a reason")
    wording = {**DEFAULT_LABELS, **(labels or {})}

    def real(option):
        base = {"id": option["id"], "label": option["label"], "consequence": option["consequence"],
                "recommended": option is picks[0], "action": {"kind": "relay-choice", "value": option["id"]}}
        return {**base, "marker": wording["recommended"], "reason": option["reason"]} if option is picks[0] else base

    exits = [{"id": name, "label": wording[name], "consequence": wording[name + "Consequence"], "recommended": False,
              "action": {"kind": "relay-choice", "value": name}} for name in ("discuss", "other")]
    location = request["where"]
    card = {"id": request["id"], "kind": "decision-request", "project": request.get("project"),
            "question": " ".join(request["question"].split()),
            "options": [real(option) for option in sorted(options, key=lambda o: o is not picks[0])] + exits,
            "discuss": True, "where": location, "sourceGap": False, "waitingSince": waiting_since}
    if not urlsplit(location).scheme:
        card.update(whereFallback=True, whereKind="local-source-fallback", whereLabel=wording["fallback"])
    return card


def resolve_answer(card, option_id, text=None):
    """Return the chosen option; free text belongs to the write-in exit alone."""
    option = next((item for item in card["options"] if item["id"] == option_id), None)
    if option is None:
        raise ValueError(f"unknown option: {option_id}")
    if (option_id == "other") != _text(text):
        raise ValueError("free text goes with the write-in option, and only there")
    return option


def semantic_hash(card):
    """Hash only the card contract; adapter timestamps and extra fields are ignored."""
    semantic = {key: card[key] for key in ("id", "project", "question", "options", "discuss", "where", "sourceGap")}
    return hashlib.sha256(json.dumps(semantic, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def forget_closed(state, closed_refs):
    """Copy metadata, forgetting only explicitly closed refs."""
    closed = set(closed_refs)
    return {ref: dict(metadata) for ref, metadata in state.items() if ref not in closed}


def due_ids(state, now):
    """Refs needing a fresh source description, ordered for deterministic callers."""
    instant = _instant(now)
    return sorted(ref for ref, metadata in state.items() if _instant(metadata["nextDue"]) <= instant)


def _morning(instant, zone, days, hour):
    date = instant.astimezone(zone).date() + timedelta(days=days)
    wall = datetime.combine(date, time(hour=hour), tzinfo=zone)
    # In unusual zones where the configured hour is skipped, use the first
    # representable wall time after it. Repeated hours use the first occurrence.
    return wall.astimezone(dt_timezone.utc).astimezone(zone)


def select_due(cards, state, now, timezone, *, next_morning_hour=9, interval_days=2, closed_refs=()):
    """Return (emitted_cards, candidate_state), without mutating arguments.

    New/changed semantic cards emit immediately and reset backoff. The first
    unchanged reminder is the next local calendar morning; later reminders
    schedule interval_days after actual emission, at the same local hour.
    A duplicate ref with differing cards is rejected; identical duplicates emit
    once. Only explicit closures forget state. Omitted delta refs remain intact.
    The candidate metadata is a delivery receipt proposal, not an acknowledgement.
    """
    if not isinstance(next_morning_hour, int) or isinstance(next_morning_hour, bool) or not 0 <= next_morning_hour <= 23:
        raise ValueError("next_morning_hour must be an integer from 0 to 23")
    if not isinstance(interval_days, int) or isinstance(interval_days, bool) or interval_days < 1:
        raise ValueError("interval_days must be a positive integer")
    instant, zone = _instant(now), ZoneInfo(timezone)
    closed = set(closed_refs)
    candidate = forget_closed(state, closed)
    unique = {}
    for card in cards:
        ref, digest = card["id"], semantic_hash(card)
        if ref in closed:
            continue
        if ref in unique and unique[ref][1] != digest:
            raise ValueError(f"conflicting cards for ref: {ref}")
        unique[ref] = (card, digest)
    emitted = []
    for ref in sorted(unique):
        card, digest = unique[ref]
        previous = candidate.get(ref)
        changed = previous is None or previous["hash"] != digest
        if not changed and _instant(previous["nextDue"]) > instant:
            continue
        count = 0 if changed else previous["reminderCount"] + 1
        next_due = _morning(instant, zone, 1 if changed else interval_days, next_morning_hour)
        candidate[ref] = {"hash": digest, "lastEmission": _stamp(instant),
                          "nextDue": _stamp(next_due), "reminderCount": count}
        emitted.append(card)
    return emitted, candidate
