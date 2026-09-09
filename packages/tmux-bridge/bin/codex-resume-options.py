#!/usr/bin/env python3
"""Reconstruct policy-sensitive Codex resume arguments from session metadata."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shlex
import sys
from typing import Any
from uuid import UUID


EFFORTS = {"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}
APPROVAL_POLICIES = {"untrusted", "on-failure", "on-request", "never"}
SANDBOX_POLICIES = {"read-only", "workspace-write", "danger-full-access"}
WORKSPACE_WRITE_FIELDS = {
    "writable_roots": list,
    "network_access": bool,
    "exclude_tmpdir_env_var": bool,
    "exclude_slash_tmp": bool,
}


class PolicyError(Exception):
    pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", required=True)
    parser.add_argument("--root", required=True)
    return parser.parse_args()


def require_uuid(value: str) -> str:
    try:
        parsed = UUID(value)
    except ValueError as error:
        raise PolicyError("session must be a complete UUID") from error
    if str(parsed) != value.lower():
        raise PolicyError("session must be a canonical UUID")
    return str(parsed)


def load_records(path: Path) -> list[dict[str, Any]]:
    records = []
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError as error:
                    raise PolicyError("transcript contains invalid JSON") from error
                if not isinstance(record, dict):
                    raise PolicyError("transcript record must be an object")
                records.append(record)
    except OSError as error:
        raise PolicyError("transcript could not be read") from error
    return records


def matching_context(root: Path, session_id: str) -> dict[str, Any]:
    if not root.is_dir():
        raise PolicyError("session root is not a directory")
    candidates = []
    for path in root.rglob("*.jsonl"):
        if session_id not in path.name:
            continue
        try:
            candidates.append((path.stat().st_mtime_ns, path))
        except OSError:
            continue
    for _, path in sorted(candidates, reverse=True):
        records = load_records(path)
        metadata = next((record for record in records if record.get("type") == "session_meta"), None)
        payload = metadata.get("payload") if isinstance(metadata, dict) else None
        if not isinstance(payload, dict) or payload.get("id") != session_id:
            continue
        for record in reversed(records):
            if record.get("type") != "turn_context":
                continue
            context = record.get("payload")
            if not isinstance(context, dict):
                raise PolicyError("turn_context payload must be an object")
            return context
    raise PolicyError("no matching turn_context was found")


def required_string(context: dict[str, Any], key: str) -> str:
    value = context.get(key)
    if not isinstance(value, str) or not value:
        raise PolicyError(f"missing or invalid {key}")
    return value


def json_value(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def render_options(context: dict[str, Any]) -> str:
    model = required_string(context, "model")
    effort = required_string(context, "effort")
    if effort not in EFFORTS:
        raise PolicyError("unsupported effort")
    approval_policy = required_string(context, "approval_policy")
    if approval_policy not in APPROVAL_POLICIES:
        raise PolicyError("unsupported approval_policy")
    cwd = required_string(context, "cwd")
    if not os.path.isabs(cwd):
        raise PolicyError("cwd must be absolute")

    sandbox = context.get("sandbox_policy")
    if not isinstance(sandbox, dict):
        raise PolicyError("missing or invalid sandbox_policy")
    sandbox_type = sandbox.get("type")
    if sandbox_type not in SANDBOX_POLICIES:
        raise PolicyError("unsupported sandbox_policy")

    args = [
        "-c", f"model={json_value(model)}",
        "-c", f"model_reasoning_effort={json_value(effort)}",
        "-c", f"approval_policy={json_value(approval_policy)}",
    ]
    if sandbox_type == "workspace-write":
        for key, expected_type in WORKSPACE_WRITE_FIELDS.items():
            if key not in sandbox:
                continue
            value = sandbox[key]
            if not isinstance(value, expected_type):
                raise PolicyError(f"invalid sandbox_policy.{key}")
            if key == "writable_roots" and any(
                not isinstance(root, str) or not os.path.isabs(root) for root in value
            ):
                raise PolicyError("invalid sandbox_policy.writable_roots")
            args.extend(["-c", f"sandbox_workspace_write.{key}={json_value(value)}"])
    args.extend(["--sandbox", sandbox_type, "--cd", cwd])
    return shlex.join(args)


def main() -> int:
    try:
        args = parse_args()
        session_id = require_uuid(args.session)
        context = matching_context(Path(args.root), session_id)
        print(render_options(context))
        return 0
    except PolicyError as error:
        print(f"codex-resume-options: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
