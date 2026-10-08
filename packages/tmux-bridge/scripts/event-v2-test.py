#!/usr/bin/env python3
"""Synthetic records with the shape of persisted Codex and Claude turns."""

import importlib.util
import json
import os
import tempfile
from pathlib import Path


watcher_path = Path(__file__).resolve().parents[1] / "bin" / "agent-watch.py"
spec = importlib.util.spec_from_file_location("agent_watch", watcher_path)
watcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watcher)
session_id = "11111111-1111-4111-8111-111111111111"


def parse(agent, records):
    return [item for record in records for item in watcher.events_for(agent, record, session_id)]


codex = parse("codex", [
    {"type": "response_item", "timestamp": "2026-01-01T00:00:00Z", "payload": {"type": "message", "role": "assistant", "phase": "commentary", "content": [{"type": "output_text", "text": "Working"}]}},
    {"type": "response_item", "timestamp": "2026-01-01T00:00:01Z", "payload": {"type": "custom_tool_call", "name": "request_user_input", "input": '{"questions":[{"question":"Choose one?"}]}' }},
    {"type": "response_item", "timestamp": "2026-01-01T00:00:02Z", "payload": {"type": "message", "role": "assistant", "phase": "final_answer", "content": [{"type": "output_text", "text": "Done"}]}},
    {"type": "event_msg", "timestamp": "2026-01-01T00:00:03Z", "payload": {"type": "task_complete", "turn_id": "turn-1", "last_agent_message": "Done"}},
    {"type": "event_msg", "timestamp": "2026-01-01T00:00:04Z", "payload": {"type": "task_complete", "turn_id": "turn-2", "last_agent_message": None, "error": {"message": "Selected model is at capacity", "codex_error_info": "server_overloaded"}}},
    {"type": "event_msg", "timestamp": "2026-01-01T00:00:05Z", "payload": {"type": "task_complete", "turn_id": "turn-3", "last_agent_message": None}},
])
assert all(item["schema"] == "agent-mesh.event.v2" for item in codex)
assert [item["phase"] for item in codex if item["kind"] == "agent_message"] == ["commentary", "final"]
assert [item["body"] for item in codex if item["kind"] == "question"] == ["Choose one?"]
turns = [item for item in codex if item["kind"] == "turn_complete"]
assert [(item["turn_id"], item["outcome"]) for item in turns] == [("turn-1", "replied"), ("turn-2", "error"), ("turn-3", "no_reply")]
assert turns[0]["reply"] == "Done"
assert turns[1]["error"] == {"message": "Selected model is at capacity", "code": "server_overloaded"}
assert len({item["source_event_id"] for item in codex}) == len(codex)

claude = parse("claude", [{"type": "assistant", "timestamp": "2026-01-01T00:01:00Z", "message": {"stop_reason": "end_turn", "content": [
    {"type": "tool_use", "name": "AskUserQuestion", "input": {"questions": [{"question": "Continue?"}]}},
    {"type": "text", "text": "Please decide"},
]}}])
assert [item["body"] for item in claude if item["kind"] == "question"] == ["Continue?"]
assert [item["reply"] for item in claude if item["kind"] == "turn_complete"] == ["Please decide"]

with tempfile.TemporaryDirectory() as directory:
    launch_path = Path(directory) / "launches.jsonl"
    launch_path.write_text(json.dumps({
        "schema": "agent-mesh.bridge-launch-event.v1", "threadId": session_id,
        "caller": "22222222-2222-4222-8222-222222222222",
    }) + "\n", encoding="utf-8")
    os.environ["AGENT_MESH_LAUNCH_EVENTS"] = str(launch_path)
    parent = watcher.bridge_parents()[session_id]
    assert watcher.session_origin("codex", {}, parent) == "bridge-worker"
    assert watcher.session_origin("codex", {"source": '{"subagent": {"thread_spawn_depth": 1}}'}, None) == "subagent"
    assert watcher.transcript_created_at("codex", Path("rollout-2026-01-02T03-04-05-" + session_id + ".jsonl")) == "2026-01-02T03:04:05Z"
print("PASS: Event v2 parser")
