#!/usr/bin/env python3
"""Small Hermes-side cc-mesh bridge helper.

Hermes installations can call this from a gateway hook or wrapper before
dispatching inbound messages and before sending outbound Discord messages.
It intentionally mirrors the skill protocol instead of defining a new one.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path


def norm(value: str) -> str:
    return (value or "").strip().lower()


def config_candidates(path: str | None) -> list[Path]:
    candidates = []
    if path:
        candidates.append(Path(path))
    env = os.environ.get("MESH_PARTICIPANTS_JSON")
    if env:
        candidates.append(Path(env))
    candidates.append(Path.home() / ".config" / "mesh-discord-routing" / "participants.json")
    candidates.append(Path("/etc/mesh-discord-routing/participants.json"))
    return candidates


def load_participants(path: str | None) -> dict:
    for candidate in config_candidates(path):
        if candidate.exists():
            return json.loads(candidate.read_text()).get("participants", {})
    return {}


def parse_recipients(text: str) -> list[str]:
    match = re.search(r"(?:^|\n)\s*cc-mesh:\s*([^\n]+)", text or "", re.I)
    if not match:
        return []
    return [item.strip() for item in match.group(1).split(",") if item.strip()]


def alias_map(participants: dict) -> dict[str, str]:
    result = {}
    for label, entry in participants.items():
        result[norm(label)] = label
        for alias in entry.get("aliases", []):
            result[norm(alias)] = label
    return result


def hydrate(text: str, participants: dict) -> str:
    recipients = parse_recipients(text)
    if not recipients or re.search(r"<@!?\d{15,25}>", text or ""):
        return text
    aliases = alias_map(participants)
    labels = []
    mentions = []
    unknown = []
    for raw in recipients:
        label = aliases.get(norm(raw))
        entry = participants.get(label or "")
        if not entry or not entry.get("discordUserId"):
            unknown.append(raw)
            continue
        labels.append(label)
        mentions.append(f"<@{entry['discordUserId']}>")
    if unknown:
        raise SystemExit(f"unknown recipient label(s): {', '.join(unknown)}")
    body = re.sub(r"(?:^|\n)\s*cc-mesh:\s*[^\n]+\n?", "", text or "", count=1, flags=re.I).strip()
    labels = list(dict.fromkeys(labels))
    mentions = list(dict.fromkeys(mentions))
    return f"cc-mesh: {','.join(labels)}\n{' '.join(mentions)} {body}".strip()


def addressed(text: str, participants: dict, local_labels: list[str]) -> bool:
    aliases = alias_map(participants)
    recipients = {norm(aliases.get(norm(item), item)) for item in parse_recipients(text)}
    for local in local_labels:
        canonical = aliases.get(norm(local), local)
        if norm(local) in recipients or norm(canonical) in recipients:
            return True
    return False


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["hydrate", "addressed"], required=True)
    parser.add_argument("--config")
    parser.add_argument("--local-label", action="append", default=[])
    parser.add_argument("--text", required=True)
    args = parser.parse_args()
    participants = load_participants(args.config)
    if args.mode == "hydrate":
        print(hydrate(args.text, participants))
    else:
        print("true" if addressed(args.text, participants, args.local_label) else "false")


if __name__ == "__main__":
    main()
