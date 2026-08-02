#!/usr/bin/env python3
"""Follow persisted Codex or Claude session events without attaching to the TUI.

The watcher is transport-only: it reads a transcript, advances a caller-owned
cursor file, and emits normalized events. It never writes to or resumes the
watched session. A host may consume the JSONL output and pass final events to an
existing Agent Mesh transport.
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Iterable


DEFAULT_ROOTS = {
    "codex": Path.home() / ".codex" / "sessions",
    "claude": Path.home() / ".claude" / "projects",
}
ROOT_ENV = {
    "codex": "CODEX_SESSION_ROOT",
    "claude": "CLAUDE_SESSION_ROOT",
}
MAX_BODY = 1400
MAX_REASONING = 300


def session_root(agent: str) -> Path:
    override = os.environ.get(ROOT_ENV[agent])
    return Path(override).expanduser() if override else DEFAULT_ROOTS[agent]


def resolve_transcript(agent: str, session_id: str) -> Path | None:
    root = session_root(agent)
    hits = [Path(path) for path in glob.glob(str(root / "**" / f"*{session_id}*.jsonl"), recursive=True)]
    existing = [path for path in hits if path.is_file()]
    return max(existing, key=lambda path: path.stat().st_mtime_ns, default=None)


def valid_session_id(value: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9_-]+", value))


def load_state(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp")
    temporary.write_text(json.dumps(state, sort_keys=True), encoding="utf-8")
    os.replace(temporary, path)


def clipped(value: Any, limit: int = MAX_BODY) -> str:
    text = str(value or "").strip()
    if len(text) <= limit:
        return text
    return f"{text[:limit]}\n[…truncated, {len(text)} characters total]"


def event(
    *,
    timestamp: str | None,
    agent: str,
    session_id: str,
    kind: str,
    body: str = "",
    phase: str | None = None,
    tool_name: str | None = None,
) -> dict[str, Any]:
    return {
        "timestamp": timestamp,
        "agent": agent,
        "session_id": session_id,
        "kind": kind,
        "body": body,
        **({"phase": phase} if phase else {}),
        **({"tool_name": tool_name} if tool_name else {}),
    }


def codex_events(record: dict[str, Any], session_id: str) -> Iterable[dict[str, Any]]:
    record_type = record.get("type")
    payload = record.get("payload") or {}
    payload_type = payload.get("type")
    timestamp = record.get("timestamp")

    if record_type == "event_msg":
        if payload_type == "user_message":
            body = clipped(payload.get("message"))
            if body:
                yield event(timestamp=timestamp, agent="codex", session_id=session_id, kind="human_message", body=body)
        elif payload_type == "agent_message":
            body = clipped(payload.get("message"))
            if body:
                raw_phase = str(payload.get("phase") or "unknown")
                phase = "final" if raw_phase in {"final", "final_answer"} else raw_phase
                yield event(
                    timestamp=timestamp,
                    agent="codex",
                    session_id=session_id,
                    kind="agent_message",
                    body=body,
                    phase=phase,
                )
        elif payload_type == "agent_reasoning":
            body = clipped(payload.get("text"), MAX_REASONING)
            if body:
                yield event(timestamp=timestamp, agent="codex", session_id=session_id, kind="reasoning", body=body)
        elif payload_type == "task_complete":
            yield event(timestamp=timestamp, agent="codex", session_id=session_id, kind="turn_complete")
        return

    if record_type == "response_item" and payload_type in {"custom_tool_call", "function_call"}:
        body = clipped(payload.get("input") or payload.get("arguments"), 260)
        yield event(
            timestamp=timestamp,
            agent="codex",
            session_id=session_id,
            kind="tool",
            body=body,
            tool_name=str(payload.get("name") or "unknown"),
        )
    elif record_type == "turn_context":
        body = json.dumps(
            {
                "model": payload.get("model"),
                "reasoning_effort": payload.get("reasoning_effort"),
                "cwd": payload.get("cwd"),
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        yield event(timestamp=timestamp, agent="codex", session_id=session_id, kind="context", body=body)


def claude_events(record: dict[str, Any], session_id: str) -> Iterable[dict[str, Any]]:
    record_type = record.get("type")
    if record_type not in {"user", "assistant"}:
        return
    if record.get("isSidechain") or record.get("isMeta"):
        return

    message = record.get("message") or {}
    content = message.get("content")
    timestamp = record.get("timestamp")

    if isinstance(content, str):
        if record_type == "user":
            body = clipped(content)
            if body:
                yield event(timestamp=timestamp, agent="claude", session_id=session_id, kind="human_message", body=body)
        return

    if not isinstance(content, list):
        return

    final_message_seen = False
    for block in content:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if record_type == "user" and block_type == "text":
            body = clipped(block.get("text"))
            if body:
                yield event(timestamp=timestamp, agent="claude", session_id=session_id, kind="human_message", body=body)
        elif record_type == "assistant" and block_type == "text":
            body = clipped(block.get("text"))
            if body:
                phase = "final" if message.get("stop_reason") == "end_turn" else "commentary"
                final_message_seen = final_message_seen or phase == "final"
                yield event(
                    timestamp=timestamp,
                    agent="claude",
                    session_id=session_id,
                    kind="agent_message",
                    body=body,
                    phase=phase,
                )
        elif record_type == "assistant" and block_type == "thinking":
            body = clipped(block.get("thinking"), MAX_REASONING)
            if body:
                yield event(timestamp=timestamp, agent="claude", session_id=session_id, kind="reasoning", body=body)
        elif record_type == "assistant" and block_type == "tool_use":
            body = clipped(json.dumps(block.get("input") or {}, ensure_ascii=False, sort_keys=True), 260)
            yield event(
                timestamp=timestamp,
                agent="claude",
                session_id=session_id,
                kind="tool",
                body=body,
                tool_name=str(block.get("name") or "unknown"),
            )
    if final_message_seen:
        yield event(timestamp=timestamp, agent="claude", session_id=session_id, kind="turn_complete")


def events_for(agent: str, record: dict[str, Any], session_id: str) -> Iterable[dict[str, Any]]:
    rendered = codex_events(record, session_id) if agent == "codex" else claude_events(record, session_id)
    source_record_id = record.get("uuid")
    if not isinstance(source_record_id, str) or not source_record_id:
        canonical = json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        source_record_id = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    for index, item in enumerate(rendered):
        yield {**item, "source_event_id": f"{source_record_id}:{index}"}


def render_text(item: dict[str, Any]) -> str:
    timestamp = str(item.get("timestamp") or "")
    clock = timestamp[11:19] if len(timestamp) >= 19 else ""
    kind = item["kind"]
    labels = {
        "human_message": "HUMAN",
        "agent_message": item["agent"].upper(),
        "reasoning": f"{item['agent']}/reasoning",
        "tool": f"tool:{item.get('tool_name', 'unknown')}",
        "turn_complete": "turn_complete",
        "context": "turn_context",
    }
    phase = f"/{item['phase']}" if item.get("phase") else ""
    header = f"[{clock}] {labels.get(kind, kind)}{phase}".strip()
    return header if not item.get("body") else f"{header} {item['body']}"


def emit(item: dict[str, Any], output_format: str) -> None:
    if output_format == "jsonl":
        print(json.dumps(item, ensure_ascii=False, sort_keys=True), flush=True)
    else:
        print(render_text(item), flush=True)


def consume(
    *,
    agent: str,
    session_id: str,
    state: dict[str, Any],
    output_format: str,
) -> tuple[int, bool]:
    path = Path(str(state["path"]))
    try:
        size = path.stat().st_size
    except OSError:
        return 0, False

    offset = int(state.get("offset", 0))
    if size < offset:
        offset = 0
        state["offset"] = 0
    if size <= offset:
        return 0, offset != int(state.get("offset", 0))

    with path.open("rb") as handle:
        handle.seek(offset)
        chunk = handle.read(size - offset)

    newline = chunk.rfind(b"\n")
    if newline < 0:
        return 0, False

    state["offset"] = offset + newline + 1
    count = 0
    for raw_line in chunk[: newline + 1].decode("utf-8", "replace").splitlines():
        try:
            record = json.loads(raw_line)
        except (TypeError, ValueError):
            continue
        if not isinstance(record, dict):
            continue
        for item in events_for(agent, record, session_id):
            emit(item, output_format)
            count += 1
    return count, True


def initial_state(agent: str, session_id: str, transcript: Path) -> dict[str, Any]:
    return {
        "agent": agent,
        "session_id": session_id,
        "path": str(transcript),
        "offset": 0,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("session_id")
    parser.add_argument("--agent", choices=sorted(DEFAULT_ROOTS), required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--format", choices=("text", "jsonl"), default="text")
    parser.add_argument("--interval", type=float, default=2.0)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--init", action="store_true")
    mode.add_argument("--drain", action="store_true")
    args = parser.parse_args()

    if not valid_session_id(args.session_id):
        parser.error("session_id may contain only letters, numbers, underscores, and hyphens")
    if args.interval <= 0:
        parser.error("--interval must be greater than zero")

    transcript = resolve_transcript(args.agent, args.session_id)
    if transcript is None:
        print(f"ERROR: no {args.agent} transcript for session {args.session_id}", file=sys.stderr)
        return 1

    state = load_state(args.state)
    if (
        state.get("agent") != args.agent
        or state.get("session_id") != args.session_id
        or state.get("path") != str(transcript)
    ):
        state = initial_state(args.agent, args.session_id, transcript)

    if args.init:
        state["offset"] = transcript.stat().st_size
        save_state(args.state, state)
        if args.format == "text":
            print(f"[watcher] armed on {transcript.name} at EOF", flush=True)
        return 0

    if args.drain:
        count, changed = consume(
            agent=args.agent,
            session_id=args.session_id,
            state=state,
            output_format=args.format,
        )
        if changed:
            save_state(args.state, state)
        if count == 0 and args.format == "text":
            print("[watcher] no new events", flush=True)
        return 0

    while True:
        current = resolve_transcript(args.agent, args.session_id)
        if current is not None and current != Path(str(state["path"])):
            state = initial_state(args.agent, args.session_id, current)
            if args.format == "text":
                print(f"[watcher] resumed on {current.name}", flush=True)

        _, changed = consume(
            agent=args.agent,
            session_id=args.session_id,
            state=state,
            output_format=args.format,
        )
        if changed:
            save_state(args.state, state)
        time.sleep(args.interval)


if __name__ == "__main__":
    raise SystemExit(main())
