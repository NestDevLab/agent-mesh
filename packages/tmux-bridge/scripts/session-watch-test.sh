#!/usr/bin/env bash
# Deterministic transcript fixtures for the runtime-neutral session watcher.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WATCHER="$BRIDGE_DIR/bin/agent-watch.py"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-mesh-session-watch.XXXXXX")"

cleanup() {
    rm -rf "$WORKDIR"
}
trap cleanup EXIT INT TERM

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

command -v python3 >/dev/null 2>&1 || fail "python3 is required"
[[ -f "$WATCHER" ]] || fail "missing watcher: $WATCHER"

export CODEX_SESSION_ROOT="$WORKDIR/codex"
export CLAUDE_SESSION_ROOT="$WORKDIR/claude"
mkdir -p "$CODEX_SESSION_ROOT/2026/08/02" "$CLAUDE_SESSION_ROOT/project"

CODEX_ID="11111111-1111-1111-1111-111111111111"
CLAUDE_ID="22222222-2222-2222-2222-222222222222"
CODEX_LOG="$CODEX_SESSION_ROOT/2026/08/02/rollout-$CODEX_ID.jsonl"
CLAUDE_LOG="$CLAUDE_SESSION_ROOT/project/$CLAUDE_ID.jsonl"
CODEX_STATE="$WORKDIR/codex-state.json"
CLAUDE_STATE="$WORKDIR/claude-state.json"

printf '%s\n' '{"timestamp":"2026-08-02T10:00:00Z","type":"session_meta","payload":{"id":"seed"}}' > "$CODEX_LOG"
python3 "$WATCHER" "$CODEX_ID" --agent codex --state "$CODEX_STATE" --init >/dev/null

printf '%s\n' \
    '{"timestamp":"2026-08-02T10:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"hello codex"}}' \
    '{"timestamp":"2026-08-02T10:00:02Z","type":"event_msg","payload":{"type":"agent_reasoning","text":"checking"}}' \
    '{"timestamp":"2026-08-02T10:00:03Z","type":"response_item","payload":{"type":"custom_tool_call","name":"shell","input":"pwd"}}' \
    '{"timestamp":"2026-08-02T10:00:03Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"pwd\"}"}}' \
    '{"timestamp":"2026-08-02T10:00:04Z","type":"event_msg","payload":{"type":"agent_message","phase":"final_answer","message":"hello human"}}' \
    '{"timestamp":"2026-08-02T10:00:05Z","type":"event_msg","payload":{"type":"task_complete"}}' \
    >> "$CODEX_LOG"

codex_output="$(python3 "$WATCHER" "$CODEX_ID" --agent codex --state "$CODEX_STATE" --drain --format jsonl)"
python3 - "$codex_output" <<'PY'
import json, sys
items = [json.loads(line) for line in sys.argv[1].splitlines()]
assert [item["kind"] for item in items] == [
    "human_message", "reasoning", "tool", "tool", "agent_message", "turn_complete"
]
assert items[4]["phase"] == "final"
assert items[2]["tool_name"] == "shell"
assert items[3]["tool_name"] == "exec_command"
assert len({item["source_event_id"] for item in items}) == len(items)
PY

second_codex="$(python3 "$WATCHER" "$CODEX_ID" --agent codex --state "$CODEX_STATE" --drain --format jsonl)"
[[ -z "$second_codex" ]] || fail "second Codex drain replayed events"

# Truncation under the same path resets the cursor safely.
printf '%s\n' '{"timestamp":"2026-08-02T10:00:06Z","type":"event_msg","payload":{"type":"user_message","message":"after truncation"}}' > "$CODEX_LOG"
truncated_output="$(python3 "$WATCHER" "$CODEX_ID" --agent codex --state "$CODEX_STATE" --drain --format jsonl)"
python3 - "$truncated_output" <<'PY'
import json, sys
items = [json.loads(line) for line in sys.argv[1].splitlines()]
assert len(items) == 1
assert items[0]["body"] == "after truncation"
PY

printf '%s\n' '{"type":"system","timestamp":"2026-08-02T10:01:00Z"}' > "$CLAUDE_LOG"
python3 "$WATCHER" "$CLAUDE_ID" --agent claude --state "$CLAUDE_STATE" --init >/dev/null

printf '%s\n' \
    '{"type":"user","timestamp":"2026-08-02T10:01:01Z","message":{"content":"hello claude"}}' \
    '{"type":"user","timestamp":"2026-08-02T10:01:01Z","message":{"content":[{"type":"text","text":"hello from blocks"}]}}' \
    '{"type":"assistant","timestamp":"2026-08-02T10:01:02Z","message":{"stop_reason":"tool_use","content":[{"type":"thinking","thinking":"checking"},{"type":"text","text":"working"},{"type":"tool_use","name":"Bash","input":{"command":"pwd"}}]}}' \
    '{"type":"assistant","timestamp":"2026-08-02T10:01:03Z","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"done"}]}}' \
    >> "$CLAUDE_LOG"

claude_output="$(python3 "$WATCHER" "$CLAUDE_ID" --agent claude --state "$CLAUDE_STATE" --drain --format jsonl)"
python3 - "$claude_output" <<'PY'
import json, sys
items = [json.loads(line) for line in sys.argv[1].splitlines()]
assert [item["kind"] for item in items] == [
    "human_message", "human_message", "reasoning", "agent_message", "tool", "agent_message", "turn_complete"
]
assert items[1]["body"] == "hello from blocks"
assert items[3]["phase"] == "commentary"
assert items[5]["phase"] == "final"
assert items[4]["tool_name"] == "Bash"
PY

# Claude Desktop Monitor persists inbox wakes as queued task-notification
# attachments. Unwrap the durable record back to the original Mesh prompt so
# the hop-limit policy recognizes the turn as relay input rather than a new
# human turn.
python3 - "$CLAUDE_LOG" <<'PY'
import json, sys
record = {
    "schema": "agent-mesh.monitor-inbox.v1",
    "deliveryId": "delivery-1",
    "meshId": "mesh-1",
    "prompt": "ccm:v1 id=mesh-1 from=codex turn=claude final=1 hop=2\n\nreview this",
}
notification = (
    "<task-notification><task-id>monitor-1</task-id>"
    f"<event>AGENT_MESH_INBOX {json.dumps(record, separators=(',', ':'))}</event>"
    "</task-notification>"
)
attachment = {
    "type": "attachment",
    "timestamp": "2026-08-02T10:01:04Z",
    "attachment": {
        "type": "queued_command",
        "commandMode": "task-notification",
        "prompt": notification,
    },
}
with open(sys.argv[1], "a", encoding="utf-8") as handle:
    handle.write(json.dumps(attachment) + "\n")
PY

monitor_output="$(python3 "$WATCHER" "$CLAUDE_ID" --agent claude --state "$CLAUDE_STATE" --drain --format jsonl)"
python3 - "$monitor_output" <<'PY'
import json, sys
items = [json.loads(line) for line in sys.argv[1].splitlines()]
assert len(items) == 1
assert items[0]["kind"] == "human_message"
assert items[0]["body"].startswith("ccm:v1 id=mesh-1")
assert items[0]["body"].endswith("review this")
PY

# A resumed session may move to a newer matching transcript. The watcher follows
# the newest file and starts at its first committed record.
sleep 0.01
CLAUDE_RESUMED="$CLAUDE_SESSION_ROOT/project/resumed-$CLAUDE_ID.jsonl"
printf '%s\n' '{"type":"user","timestamp":"2026-08-02T10:02:00Z","message":{"content":"after resume"}}' > "$CLAUDE_RESUMED"
resumed_output="$(python3 "$WATCHER" "$CLAUDE_ID" --agent claude --state "$CLAUDE_STATE" --drain --format jsonl)"
python3 - "$resumed_output" <<'PY'
import json, sys
items = [json.loads(line) for line in sys.argv[1].splitlines()]
assert len(items) == 1
assert items[0]["kind"] == "human_message"
assert items[0]["body"] == "after resume"
PY

if python3 "$WATCHER" '../bad' --agent claude --state "$CLAUDE_STATE" --drain >/dev/null 2>&1; then
    fail "unsafe session id was accepted"
fi

echo "PASS: session watcher"
