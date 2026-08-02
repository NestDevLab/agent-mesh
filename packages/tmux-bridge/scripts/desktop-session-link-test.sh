#!/usr/bin/env bash
# End-to-end synthetic test for Codex tmux <-> Claude Desktop Monitor transport.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LINK="$BRIDGE_DIR/bin/agent-link.mjs"
INBOX_WATCH="$BRIDGE_DIR/bin/agent-inbox-watch.mjs"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-mesh-desktop-link.XXXXXX")"
WATCH_PID=""

cleanup() {
    [[ -z "$WATCH_PID" ]] || kill "$WATCH_PID" 2>/dev/null || true
    [[ -z "$WATCH_PID" ]] || wait "$WATCH_PID" 2>/dev/null || true
    rm -rf "$WORKDIR"
}
trap cleanup EXIT INT TERM

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

export CODEX_SESSION_ROOT="$WORKDIR/codex"
export CLAUDE_SESSION_ROOT="$WORKDIR/claude"
export AGENT_LINK_SEND_LOG="$WORKDIR/send-log.jsonl"
export AGENT_LINK_WRITER_LOG="$WORKDIR/writer-log.jsonl"
mkdir -p "$CODEX_SESSION_ROOT/2026/08/02" "$CLAUDE_SESSION_ROOT/project"
: > "$AGENT_LINK_SEND_LOG"
: > "$AGENT_LINK_WRITER_LOG"

CODEX_ID="55555555-5555-5555-5555-555555555555"
CLAUDE_ID="66666666-6666-6666-6666-666666666666"
CODEX_LOG="$CODEX_SESSION_ROOT/2026/08/02/rollout-$CODEX_ID.jsonl"
CLAUDE_LOG="$CLAUDE_SESSION_ROOT/project/$CLAUDE_ID.jsonl"
LINK_STATE="$WORKDIR/link-state.json"
INBOX="$WORKDIR/claude-inbox.jsonl"
INBOX_CURSOR="$WORKDIR/claude-inbox.cursor.json"
MONITOR_OUTPUT="$WORKDIR/monitor-output.jsonl"
FAKE_SEND="$WORKDIR/fake-send.py"
FAKE_WRITER="$WORKDIR/fake-writer.py"

printf '%s\n' \
    '#!/usr/bin/env python3' \
    'import json, os, sys' \
    'with open(os.environ["AGENT_LINK_SEND_LOG"], "a", encoding="utf-8") as handle:' \
    '    handle.write(json.dumps(sys.argv[1:]) + "\n")' \
    > "$FAKE_SEND"
printf '%s\n' \
    '#!/usr/bin/env python3' \
    'import json, os, sys' \
    'with open(os.environ["AGENT_LINK_WRITER_LOG"], "a", encoding="utf-8") as handle:' \
    '    handle.write(json.dumps(sys.argv[1:]) + "\n")' \
    > "$FAKE_WRITER"
chmod +x "$FAKE_SEND" "$FAKE_WRITER"
export AGENT_LINK_SEND_BIN="$FAKE_SEND"
export AGENT_LINK_WRITER_STATUS_BIN="$FAKE_WRITER"

printf '%s\n' '{"timestamp":"2026-08-02T12:00:00Z","type":"session_meta","payload":{"id":"codex"}}' > "$CODEX_LOG"
printf '%s\n' '{"type":"system","timestamp":"2026-08-02T12:00:00Z"}' > "$CLAUDE_LOG"

ARGS=(
    --mode bidirectional
    --state "$LINK_STATE"
    --left-agent codex
    --left-session "$CODEX_ID"
    --left-target mesh-codex-main
    --right-agent claude
    --right-session "$CLAUDE_ID"
    --right-transport monitor-inbox
    --right-inbox "$INBOX"
)

node "$LINK" "${ARGS[@]}" --init >/dev/null
[[ -f "$INBOX" ]] || fail "Desktop inbox was not initialized"
[[ "$(stat -c '%a' "$INBOX")" == "600" ]] || fail "Desktop inbox is not private"

# Start the same event-driven follower that Claude Desktop Monitor runs.
node "$INBOX_WATCH" --inbox "$INBOX" --state "$INBOX_CURSOR" --follow > "$MONITOR_OUTPUT" &
WATCH_PID=$!

printf '%s\n' \
    '{"timestamp":"2026-08-02T12:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"compare the two designs"}}' \
    '{"timestamp":"2026-08-02T12:00:02Z","type":"event_msg","payload":{"type":"agent_reasoning","text":"checking constraints"}}' \
    '{"timestamp":"2026-08-02T12:00:03Z","type":"event_msg","payload":{"type":"agent_message","phase":"final_answer","message":"codex proposal"}}' \
    '{"timestamp":"2026-08-02T12:00:04Z","type":"event_msg","payload":{"type":"task_complete"}}' \
    >> "$CODEX_LOG"

node "$LINK" "${ARGS[@]}" --drain >/dev/null
[[ "$(wc -l < "$INBOX")" -eq 1 ]] || fail "Codex turn did not reach the Desktop inbox exactly once"
[[ ! -s "$AGENT_LINK_SEND_LOG" ]] || fail "Desktop delivery incorrectly used tmux send"

attempts=0
while [[ ! -s "$MONITOR_OUTPUT" && "$attempts" -lt 100 ]]; do
    sleep 0.02
    attempts=$((attempts + 1))
done
[[ -s "$MONITOR_OUTPUT" ]] || fail "event-driven inbox follower did not wake"
kill "$WATCH_PID" 2>/dev/null || true
wait "$WATCH_PID" 2>/dev/null || true
WATCH_PID=""
grep -q '^AGENT_MESH_INBOX ' "$MONITOR_OUTPUT" || fail "Monitor output omitted inbox marker"

python3 - "$INBOX" "$CLAUDE_LOG" <<'PY'
import json, sys
record = json.loads(open(sys.argv[1], encoding="utf-8").read())
assert record["schema"] == "agent-mesh.monitor-inbox.v1"
assert " turn=claude final=1" in record["prompt"]
assert " hop=2" in record["prompt"]
notification = (
    "<task-notification><task-id>monitor-1</task-id>"
    "<event>AGENT_MESH_INBOX {\"schema\":\"agent-mesh.monitor-inbox.v1\","
    f"\"deliveryId\":\"{record['deliveryId']}\",\"prompt\":\"ccm:v1 ...(truncated)</event>"
    "</task-notification>"
)
with open(sys.argv[2], "a", encoding="utf-8") as handle:
    handle.write(json.dumps({
        "type": "user",
        "timestamp": "2026-08-02T12:01:00Z",
        "message": {"content": notification},
    }) + "\n")
    handle.write(json.dumps({
        "type": "assistant",
        "timestamp": "2026-08-02T12:01:01Z",
        "message": {
            "stop_reason": "end_turn",
            "content": [{"type": "text", "text": "claude review"}],
        },
    }) + "\n")
PY

return_activity="$(node "$LINK" "${ARGS[@]}" --drain)"
if [[ "$(wc -l < "$AGENT_LINK_SEND_LOG")" -ne 1 ]]; then
    echo "$return_activity" >&2
    fail "Desktop return did not reach Codex exactly once"
fi

python3 - "$AGENT_LINK_SEND_LOG" "$CODEX_LOG" <<'PY'
import json, sys
args = json.loads(open(sys.argv[1], encoding="utf-8").read())
assert args[0:3] == ["--quiet", "--agent", "codex"]
assert args[3] == "mesh-codex-main"
prompt = args[4]
assert " turn=codex final=1" in prompt
assert " seen=claude" in prompt
assert " hop=1" in prompt
assert "claude review" in prompt
with open(sys.argv[2], "a", encoding="utf-8") as handle:
    handle.write(json.dumps({"timestamp":"2026-08-02T12:02:00Z","type":"event_msg","payload":{"type":"user_message","message":prompt}}) + "\n")
    handle.write(json.dumps({"timestamp":"2026-08-02T12:02:01Z","type":"event_msg","payload":{"type":"agent_message","phase":"final_answer","message":"codex integrated the review"}}) + "\n")
    handle.write(json.dumps({"timestamp":"2026-08-02T12:02:02Z","type":"event_msg","payload":{"type":"task_complete"}}) + "\n")
PY

node "$LINK" "${ARGS[@]}" --drain >/dev/null
[[ "$(wc -l < "$INBOX")" -eq 1 ]] || fail "hop limit allowed a third delivery"

python3 - "$LINK_STATE" "$INBOX_CURSOR" <<'PY'
import json, os, stat, sys
state = json.load(open(sys.argv[1], encoding="utf-8"))
cursor = json.load(open(sys.argv[2], encoding="utf-8"))
assert state["schema"] == "agent-mesh.session-link.v1"
assert state["config"]["right"]["transport"] == "monitor-inbox"
assert state["outbox"] == []
assert state["queues"] == {"left": [], "right": []}
assert cursor["schema"] == "agent-mesh.monitor-inbox-cursor.v1"
assert stat.S_IMODE(os.stat(sys.argv[1]).st_mode) == 0o600
assert stat.S_IMODE(os.stat(sys.argv[2]).st_mode) == 0o600
PY

echo "PASS: Claude Desktop event-driven session link"
