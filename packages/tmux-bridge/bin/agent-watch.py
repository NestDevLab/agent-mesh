#!/usr/bin/env python3
"""Follow persisted Codex or Claude session events without attaching to the TUI.

The watcher is transport-only: it reads a transcript, advances a caller-owned
cursor file, and emits normalized events. It never writes to or resumes the
watched session. A host may consume the JSONL output and pass final events to an
existing Agent Mesh transport.
"""

from __future__ import annotations

import argparse
import datetime
import glob
import hashlib
import json
import os
import re
import sqlite3
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
MAX_BODY = 4096
MAX_REASONING = 300
# Codex mints v7 UUIDs, Claude v4. Don't pin the version nibble.
SESSION_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"


def session_root(agent: str) -> Path:
    override = os.environ.get(ROOT_ENV[agent])
    return Path(override).expanduser() if override else DEFAULT_ROOTS[agent]


def resolve_transcript(agent: str, session_id: str) -> Path | None:
    root = session_root(agent)
    hits = [Path(path) for path in glob.glob(str(root / "**" / f"*{session_id}*.jsonl"), recursive=True)]
    existing = [path for path in hits if path.is_file()]
    return max(existing, key=lambda path: path.stat().st_mtime_ns, default=None)


def transcript_facts(agent: str, session_id: str, transcript: Path) -> dict[str, Any]:
    """Read objective transcript facts without creating a cursor or waking a session."""
    cwd = ""
    title = ""
    last_assistant = ""
    assistant_turns = 0
    for raw_line in transcript.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            record = json.loads(raw_line)
        except (TypeError, ValueError):
            continue
        if not isinstance(record, dict):
            continue
        if agent == "codex":
            payload = record.get("payload") or {}
            if record.get("type") == "session_meta":
                cwd = str(payload.get("cwd") or cwd)
            elif record.get("type") == "turn_context":
                cwd = str(payload.get("cwd") or cwd)
            for item in codex_events(record, session_id):
                if item["kind"] == "human_message" and not title:
                    title = next((line.strip() for line in str(item["body"]).splitlines() if line.strip()), "")[:240]
                elif item["kind"] == "agent_message":
                    assistant_turns += 1
                    last_assistant = str(item["body"])
        else:
            cwd = str(record.get("cwd") or cwd)
            for item in claude_events(record, session_id):
                if item["kind"] == "human_message" and not title:
                    title = next((line.strip() for line in str(item["body"]).splitlines() if line.strip()), "")[:240]
                elif item["kind"] == "agent_message":
                    assistant_turns += 1
                    last_assistant = str(item["body"])
    return {
        "agent": agent,
        "runtime_uuid": session_id,
        "path": str(transcript),
        "cwd": cwd,
        "title": title,
        "last_assistant": last_assistant,
        "assistant_turns": assistant_turns,
        "updated_at": transcript.stat().st_mtime_ns,
    }


def transcript_candidates(agent: str) -> list[tuple[str, Path]]:
    root = session_root(agent)
    if not root.is_dir():
        return []
    sessions: dict[str, Path] = {}
    for candidate in root.glob("**/*.jsonl"):
        match = re.search(SESSION_UUID, candidate.name, re.I)
        if not candidate.is_file():
            continue
        if not match:
            continue
        session_id = match.group(0).lower()
        previous = sessions.get(session_id)
        if previous is None or candidate.stat().st_mtime_ns > previous.stat().st_mtime_ns:
            sessions[session_id] = candidate
    return sorted(
        sessions.items(), key=lambda item: item[1].stat().st_mtime_ns, reverse=True
    )


def first_real_prompt(body: str) -> str:
    text = body.split("My request for Codex:", 1)[-1] if "My request for Codex:" in body else body
    return next((line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith(("<", "# AGENTS.md"))), "")[:240]


def update_facts(facts: dict[str, Any], agent: str, session_id: str, record: dict[str, Any]) -> None:
    payload = record.get("payload") or {}
    if agent == "codex" and record.get("type") in {"session_meta", "turn_context"}:
        facts["cwd"] = str(payload.get("cwd") or facts.get("cwd") or "")
    elif agent == "claude":
        facts["cwd"] = str(record.get("cwd") or facts.get("cwd") or "")
    for item in events_for(agent, record, session_id):
        kind = item["kind"]
        timestamp = item.get("timestamp")
        if kind == "human_message":
            body = str(item.get("body") or "")
            if body == facts.get("_last_human_body"):
                continue
            facts["_last_human_body"] = body
            facts["human_turns"] += 1
            facts["last_human_at"] = timestamp
            if not facts["first_real_prompt"]:
                facts["first_real_prompt"] = first_real_prompt(body)
            facts["pending_question"] = False
            facts["turn_active"] = True
        elif kind == "agent_message":
            body = str(item.get("body") or "")
            if body != facts.get("_last_agent_body"):
                facts["assistant_turns"] += 1
            facts["_last_agent_body"] = body
            facts["last_assistant"] = body
            if item.get("phase") == "final" or agent == "claude":
                facts["last_final_at"] = timestamp
                facts["pending_question"] = body.rstrip().endswith("?")
        elif kind == "tool":
            name = str(item.get("tool_name") or "")
            if name in {"Edit", "Write", "NotebookEdit", "apply_patch"}:
                facts["mutating_tool_calls"] += 1
            if name in {"AskUserQuestion", "request_user_input", "request_user_input_async"}:
                facts["pending_question"] = True
        elif kind == "turn_complete":
            facts["turn_active"] = False
        if kind in {"human_message", "agent_message", "tool", "turn_complete"}:
            facts["last_event_kind"] = kind


def empty_facts(agent: str, session_id: str, transcript: Path) -> dict[str, Any]:
    return {
        "agent": agent, "runtime_uuid": session_id, "path": str(transcript), "cwd": "", "title": "",
        "last_assistant": "", "assistant_turns": 0, "human_turns": 0,
        "mutating_tool_calls": 0, "last_human_at": None, "last_final_at": None,
        "last_event_kind": None, "pending_question": False, "first_real_prompt": "", "turn_active": False,
    }


def read_appended_facts(agent: str, session_id: str, transcript: Path, prior: dict[str, Any] | None) -> dict[str, Any]:
    stat = transcript.stat()
    reusable = (prior is not None and prior.get("path") == str(transcript)
                and isinstance(prior.get("offset"), int) and prior["offset"] <= stat.st_size
                and (prior["offset"] < stat.st_size or prior.get("mtime_ns") == stat.st_mtime_ns))
    facts = dict(prior) if reusable else empty_facts(agent, session_id, transcript)
    offset = int(facts.get("offset", 0))
    with transcript.open("rb") as handle:
        handle.seek(offset)
        while handle.tell() < stat.st_size:
            line = handle.readline(stat.st_size - handle.tell())
            if not line.endswith(b"\n"):
                break
            offset += len(line)
            try:
                record = json.loads(line.decode("utf-8", "replace"))
            except ValueError:
                continue
            if isinstance(record, dict):
                update_facts(facts, agent, session_id, record)
    facts.update(offset=offset, mtime_ns=stat.st_mtime_ns, size=stat.st_size, updated_at=stat.st_mtime_ns)
    facts["title"] = facts.get("title") or facts["first_real_prompt"]
    return facts


def codex_metadata() -> dict[str, dict[str, Any]]:
    if os.environ.get("CODEX_SESSION_ROOT") and not os.environ.get("CODEX_STATE_DB"):
        return {}
    path = Path(os.environ.get("CODEX_STATE_DB", Path.home() / ".codex" / "state_5.sqlite"))
    if not path.is_file():
        return {}
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as connection:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(threads)")}
        needed = {"id", "name", "title", "cwd", "source", "thread_source", "archived", "is_pinned"}
        if not needed <= columns:
            raise RuntimeError("Codex threads schema is missing required metadata columns")
        time_column = "updated_at_ms" if "updated_at_ms" in columns else "NULL"
        created_column = "created_at_ms" if "created_at_ms" in columns else "NULL"
        rows = connection.execute(f"SELECT id,name,title,cwd,source,thread_source,archived,is_pinned,{time_column},{created_column} FROM threads")
        return {
            row[0]: {"name": row[1] or row[2] or "", "cwd": row[3] or "", "source": row[4],
                     "thread_source": row[5], "archived": bool(row[6]), "pinned": bool(row[7]),
                     "metadata_updated_at_ns": int(row[8] or 0) * 1_000_000, "created_at_ms": row[9]}
            for row in rows
        }


def claude_metadata() -> dict[str, dict[str, Any]]:
    if os.environ.get("CLAUDE_SESSION_ROOT") and not os.environ.get("CLAUDE_SESSION_METADATA_ROOT"):
        return {}
    root = Path(os.environ.get("CLAUDE_SESSION_METADATA_ROOT", Path.home() / ".claude" / "sessions"))
    result = {}
    for path in root.glob("*.json"):
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(value, dict) and isinstance(value.get("sessionId"), str):
            try:
                os.kill(int(value["pid"]), 0)
                alive = True
            except (KeyError, ValueError, ProcessLookupError, PermissionError):
                alive = False
            entry = {key: value.get(key) for key in ("name", "status", "waitingFor", "hostSessionId", "entrypoint", "kind", "cwd", "startedAt", "updatedAt")}
            entry["live_writer"] = alive and value.get("status") == "busy"
            if not alive:
                entry.update(status=None, waitingFor=None)
            result[value["sessionId"]] = entry
    return result


def discover_transcripts(agent: str, cache_path: Path | None = None) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    root = session_root(agent)
    cached = load_state(cache_path) if cache_path else {}
    entries = cached.get(agent, {}) if cached.get("version") == 1 else {}
    metadata = codex_metadata() if agent == "codex" else claude_metadata()
    facts = []
    for session_id, path in transcript_candidates(agent):
        item = read_appended_facts(agent, session_id, path, entries.get(session_id)) if cache_path else transcript_facts(agent, session_id, path)
        item.update(metadata.get(session_id, {}))
        if item.get("name"):
            item["title"] = str(item["name"])
        if cache_path:
            entries[session_id] = item
        facts.append({key: value for key, value in item.items() if not key.startswith("_")})
    if agent == "codex":
        present = {item["runtime_uuid"] for item in facts}
        for session_id, entry in metadata.items():
            if session_id in present or entry["archived"] or not re.fullmatch(SESSION_UUID, session_id, re.I):
                continue
            item = empty_facts(agent, session_id, Path(""))
            item.update(entry)
            item.update(path="", title=entry["name"], updated_at=entry["metadata_updated_at_ns"], metadata_only=True)
            facts.append(item)
    else:
        present = {item["runtime_uuid"] for item in facts}
        for session_id, entry in metadata.items():
            if session_id in present or not re.fullmatch(SESSION_UUID, session_id, re.I):
                continue
            item = empty_facts(agent, session_id, Path(""))
            item.update(entry)
            updated = entry.get("updatedAt") or entry.get("startedAt")
            try:
                updated_ns = int(datetime.datetime.fromisoformat(str(updated).replace("Z", "+00:00")).timestamp() * 1_000_000_000)
            except ValueError:
                updated_ns = 0
            item.update(path="", title=entry.get("name") or "", updated_at=updated_ns, metadata_only=True)
            facts.append(item)
    if cache_path:
        cached.update(version=1, **{agent: entries})
        save_state(cache_path, cached)
    skipped = []
    if root.is_dir():
        for candidate in root.glob("**/*.jsonl"):
            if candidate.is_file() and not re.search(SESSION_UUID, candidate.name, re.I):
                skipped.append({"name": candidate.name, "reason": "unrecognized-session-id"})
    return facts, skipped


def visible_transcript(agent: str, session_id: str, transcript: Path) -> list[dict[str, Any]]:
    """Return only user-visible turns; never expose reasoning, tools, context, or paths."""
    items: list[dict[str, Any]] = []
    for raw_line in transcript.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            record = json.loads(raw_line)
        except (TypeError, ValueError):
            continue
        if not isinstance(record, dict):
            continue
        for item in events_for(agent, record, session_id):
            if item.get("kind") not in {"human_message", "agent_message"}:
                continue
            role = "user" if item["kind"] == "human_message" else "assistant"
            public = {
                "event_id": item["source_event_id"],
                "role": role,
                "timestamp": item.get("timestamp"),
                "text": item.get("body", ""),
            }
            # Codex can persist equivalent event_msg and response_item records.
            # Suppress only adjacent exact duplicates so distinct repeated turns survive.
            if items and all(items[-1].get(key) == public.get(key) for key in ("role", "timestamp", "text")):
                continue
            items.append(public)
    return items


def transcript_page(agent: str, session_id: str, transcript: Path, cursor: int, limit: int) -> dict[str, Any]:
    items = visible_transcript(agent, session_id, transcript)
    page = items[cursor : cursor + limit]
    next_cursor = cursor + len(page)
    return {
        "agent_type": agent,
        "session_id": session_id,
        "events": page,
        "next_cursor": next_cursor if next_cursor < len(items) else None,
    }


def search_transcripts(agent: str, query: str, cursor: int, limit: int, scan_limit: int) -> dict[str, Any]:
    needle = query.casefold()
    results: list[dict[str, Any]] = []
    candidates = transcript_candidates(agent)
    position = min(cursor, len(candidates))
    stop = min(position + scan_limit, len(candidates))
    while position < stop and len(results) < limit:
        session_id, transcript = candidates[position]
        position += 1
        item = transcript_facts(agent, session_id, transcript)
        matches = []
        for event_item in visible_transcript(agent, str(item["runtime_uuid"]), transcript):
            if needle in str(event_item["text"]).casefold():
                matches.append(event_item)
                if len(matches) >= 3:
                    break
        if not matches:
            continue
        results.append({
            "agent_type": agent,
            "session_id": item["runtime_uuid"],
            "cwd": item["cwd"],
            "updated_at": datetime.datetime.fromtimestamp(
                transcript.stat().st_mtime, datetime.timezone.utc
            ).isoformat().replace("+00:00", "Z"),
            "matches": matches,
        })
    return {
        "agent_type": agent,
        "results": results,
        "next_cursor": position if position < len(candidates) else None,
    }


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
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(state, sort_keys=True), encoding="utf-8")
    temporary.chmod(0o600)
    os.replace(temporary, path)


def clipped(value: Any, limit: int = MAX_BODY) -> str:
    text = str(value or "").strip()
    if len(text) <= limit:
        return text
    return f"{text[:limit]}\n[…truncated, {len(text)} characters total]"


def message_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, dict):
        return str(content.get("text") or "")
    if isinstance(content, list):
        return " ".join(
            block if isinstance(block, str) else str(block.get("text") or "")
            for block in content
            if isinstance(block, (str, dict))
        )
    return ""


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

    if record_type == "response_item" and payload_type == "message":
        body = clipped(message_text(payload.get("content")))
        if body:
            if payload.get("role") == "user":
                yield event(timestamp=timestamp, agent="codex", session_id=session_id, kind="human_message", body=body)
            elif payload.get("role") == "assistant":
                yield event(timestamp=timestamp, agent="codex", session_id=session_id, kind="agent_message", body=body)
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


def monitor_inbox_prompt(notification: Any, inbox: Path | None) -> str:
    text = str(notification or "")
    marker = re.search(r"AGENT_MESH_INBOX\s+(.+?)(?:</event>|$)", text, re.DOTALL)
    if not marker:
        return ""

    inbox_record: dict[str, Any] | None = None
    try:
        parsed = json.loads(marker.group(1))
        if isinstance(parsed, dict):
            inbox_record = parsed
    except (TypeError, ValueError):
        pass

    if inbox_record and inbox_record.get("schema") == "agent-mesh.monitor-inbox.v1":
        prompt = inbox_record.get("prompt")
        if isinstance(prompt, str) and prompt.strip():
            return clipped(prompt)

    delivery_match = re.search(r'"deliveryId"\s*:\s*"([^"\\]{1,300})"', marker.group(1))
    delivery_id = delivery_match.group(1) if delivery_match else ""
    if not delivery_id or inbox is None:
        return ""

    resolved_record: dict[str, Any] | None = None
    try:
        with inbox.open("r", encoding="utf-8") as handle:
            for line in handle:
                try:
                    candidate = json.loads(line)
                except (TypeError, ValueError):
                    continue
                if (
                    isinstance(candidate, dict)
                    and candidate.get("schema") == "agent-mesh.monitor-inbox.v1"
                    and candidate.get("deliveryId") == delivery_id
                    and isinstance(candidate.get("prompt"), str)
                ):
                    resolved_record = candidate
    except OSError:
        return ""

    return clipped(resolved_record.get("prompt")) if resolved_record else ""


def claude_events(
    record: dict[str, Any],
    session_id: str,
    inbox: Path | None = None,
) -> Iterable[dict[str, Any]]:
    record_type = record.get("type")
    if record_type == "attachment":
        attachment = record.get("attachment") or {}
        if attachment.get("type") != "queued_command" or attachment.get("commandMode") != "task-notification":
            return
        body = monitor_inbox_prompt(attachment.get("prompt"), inbox)
        if body:
            yield event(
                timestamp=record.get("timestamp"),
                agent="claude",
                session_id=session_id,
                kind="human_message",
                body=body,
            )
        return
    if record_type not in {"user", "assistant"}:
        return
    if record.get("isSidechain") or record.get("isMeta"):
        return

    message = record.get("message") or {}
    content = message.get("content")
    timestamp = record.get("timestamp")

    if isinstance(content, str):
        if record_type == "user":
            is_monitor_notification = "AGENT_MESH_INBOX" in content
            body = monitor_inbox_prompt(content, inbox) if is_monitor_notification else clipped(content)
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
            text = str(block.get("text") or "")
            is_monitor_notification = "AGENT_MESH_INBOX" in text
            body = monitor_inbox_prompt(text, inbox) if is_monitor_notification else clipped(text)
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


def events_for(
    agent: str,
    record: dict[str, Any],
    session_id: str,
    inbox: Path | None = None,
) -> Iterable[dict[str, Any]]:
    rendered = codex_events(record, session_id) if agent == "codex" else claude_events(record, session_id, inbox)
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
    inbox: Path | None,
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
        for item in events_for(agent, record, session_id, inbox):
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
    parser.add_argument("session_id", nargs="?")
    parser.add_argument("--agent", choices=sorted(DEFAULT_ROOTS), required=True)
    parser.add_argument("--state", type=Path)
    parser.add_argument("--inbox", type=Path)
    parser.add_argument("--format", choices=("text", "jsonl"), default="text")
    parser.add_argument("--interval", type=float, default=2.0)
    parser.add_argument("--cursor", type=int, default=0)
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--scan-limit", type=int, default=500)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--init", action="store_true")
    mode.add_argument("--drain", action="store_true")
    mode.add_argument("--inspect", action="store_true", help="read transcript facts without a cursor")
    mode.add_argument("--discover", action="store_true", help="read facts for every transcript without cursors")
    mode.add_argument("--transcript", action="store_true", help="read a bounded page of visible user and assistant turns")
    mode.add_argument("--search", metavar="QUERY", help="search visible turns across persisted transcripts")
    parser.add_argument("--report-skipped", action="store_true", help="with --discover, report transcript files skipped for an unrecognized session id")
    parser.add_argument("--cache", type=Path, help="with --discover, retain incremental transcript facts in this file")
    args = parser.parse_args()

    if not args.discover and args.search is None and not args.session_id:
        parser.error("session_id is required unless --discover or --search is used")
    if (args.discover or args.search is not None) and args.session_id:
        parser.error("session_id cannot be combined with --discover or --search")
    if args.report_skipped and not args.discover:
        parser.error("--report-skipped requires --discover")
    if args.cache and not args.discover:
        parser.error("--cache requires --discover")
    if args.session_id is not None and not valid_session_id(args.session_id):
        parser.error("session_id may contain only letters, numbers, underscores, and hyphens")
    if args.interval <= 0:
        parser.error("--interval must be greater than zero")
    if args.cursor < 0:
        parser.error("--cursor must be zero or greater")
    if args.limit < 1 or args.limit > 1000:
        parser.error("--limit must be from 1 to 1000")
    if args.scan_limit < 1 or args.scan_limit > 1000:
        parser.error("--scan-limit must be from 1 to 1000")
    if not args.inspect and not args.discover and not args.transcript and args.search is None and args.state is None:
        parser.error("--state is required unless a read-only mode is used")
    if args.inbox is not None and args.agent != "claude":
        parser.error("--inbox is supported only for Claude Monitor notifications")
    if args.inbox is not None and not args.inbox.is_file():
        parser.error(f"inbox does not exist: {args.inbox}")

    if args.discover:
        facts, skipped = discover_transcripts(args.agent, args.cache)
        report: Any = {"transcripts": facts, "skipped": skipped} if args.report_skipped else facts
        print(json.dumps(report, ensure_ascii=False, sort_keys=True) if args.format == "jsonl" else json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
        return 0

    if args.search is not None:
        query = args.search.strip()
        if not query or len(query) > 512:
            parser.error("--search must contain from 1 to 512 characters")
        matches = search_transcripts(args.agent, query, args.cursor, args.limit, args.scan_limit)
        print(json.dumps(matches, ensure_ascii=False, sort_keys=True) if args.format == "jsonl" else json.dumps(matches, ensure_ascii=False, indent=2, sort_keys=True))
        return 0

    assert args.session_id is not None
    transcript = resolve_transcript(args.agent, args.session_id)
    if transcript is None:
        print(f"ERROR: no {args.agent} transcript for session {args.session_id}", file=sys.stderr)
        return 1

    if args.inspect:
        facts = transcript_facts(args.agent, args.session_id, transcript)
        if args.format == "jsonl":
            print(json.dumps(facts, ensure_ascii=False, sort_keys=True))
        else:
            print(json.dumps(facts, ensure_ascii=False, indent=2, sort_keys=True))
        return 0

    if args.transcript:
        page = transcript_page(args.agent, args.session_id, transcript, args.cursor, args.limit)
        print(json.dumps(page, ensure_ascii=False, sort_keys=True) if args.format == "jsonl" else json.dumps(page, ensure_ascii=False, indent=2, sort_keys=True))
        return 0

    assert args.state is not None
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
            inbox=args.inbox,
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
            inbox=args.inbox,
        )
        if changed:
            save_state(args.state, state)
        time.sleep(args.interval)


if __name__ == "__main__":
    raise SystemExit(main())
