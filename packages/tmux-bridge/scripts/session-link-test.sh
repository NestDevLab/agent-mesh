#!/usr/bin/env bash
# End-to-end synthetic transcript test for the bounded Codex <-> Claude link.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LINK="$BRIDGE_DIR/bin/agent-link.mjs"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-mesh-session-link.XXXXXX")"

cleanup() {
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
mkdir -p "$CODEX_SESSION_ROOT/2026/08/02" "$CLAUDE_SESSION_ROOT/project"

CODEX_ID="33333333-3333-3333-3333-333333333333"
CLAUDE_ID="44444444-4444-4444-4444-444444444444"
CODEX_LOG="$CODEX_SESSION_ROOT/2026/08/02/rollout-$CODEX_ID.jsonl"
CLAUDE_LOG="$CLAUDE_SESSION_ROOT/project/$CLAUDE_ID.jsonl"
LINK_STATE="$WORKDIR/link-state.json"
FAKE_SEND="$WORKDIR/fake-send.py"
FAKE_WRITER="$WORKDIR/fake-writer.sh"

printf '%s\n' \
    '#!/usr/bin/env python3' \
    'import json, os, sys' \
    'with open(os.environ["AGENT_LINK_SEND_LOG"], "a", encoding="utf-8") as handle:' \
    '    handle.write(json.dumps(sys.argv[1:]) + "\n")' \
    > "$FAKE_SEND"
chmod +x "$FAKE_SEND"
export AGENT_LINK_SEND_BIN="$FAKE_SEND"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$FAKE_WRITER"
chmod +x "$FAKE_WRITER"
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
    --right-target mesh-claude-main
)

node "$LINK" "${ARGS[@]}" --init >/dev/null

printf '%s\n' \
    '{"timestamp":"2026-08-02T12:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"compare the two designs"}}' \
    '{"timestamp":"2026-08-02T12:00:02Z","type":"event_msg","payload":{"type":"agent_reasoning","text":"checking constraints"}}' \
    '{"timestamp":"2026-08-02T12:00:03Z","type":"response_item","payload":{"type":"custom_tool_call","name":"shell","input":"pwd"}}' \
    '{"timestamp":"2026-08-02T12:00:04Z","type":"event_msg","payload":{"type":"agent_message","phase":"final_answer","message":"codex proposal"}}' \
    '{"timestamp":"2026-08-02T12:00:05Z","type":"event_msg","payload":{"type":"task_complete"}}' \
    >> "$CODEX_LOG"

node "$LINK" "${ARGS[@]}" --drain >/dev/null
[[ "$(wc -l < "$AGENT_LINK_SEND_LOG")" -eq 1 ]] || fail "initial turn did not dispatch exactly once"

python3 - "$AGENT_LINK_SEND_LOG" "$CLAUDE_LOG" <<'PY'
import json, sys
args = json.loads(open(sys.argv[1], encoding="utf-8").read().splitlines()[-1])
assert args[0:3] == ["--quiet", "--agent", "claude"]
assert args[3] == "mesh-claude-main"
prompt = args[4]
assert " turn=claude final=1" in prompt
assert " hop=2" in prompt
assert "[human] compare the two designs" in prompt
assert "[codex/reasoning] checking constraints" in prompt
# Claude's interactive TUI persists multiline pasted prompts with bare CR
# separators. Exercise that real transcript shape so the envelope cannot be
# misclassified as a fresh human turn and amplified.
prompt = prompt.replace("\n", "\r")
with open(sys.argv[2], "a", encoding="utf-8") as handle:
    handle.write(json.dumps({"type":"user","timestamp":"2026-08-02T12:01:00Z","message":{"content":prompt}}) + "\n")
    handle.write(json.dumps({"type":"assistant","timestamp":"2026-08-02T12:01:01Z","message":{"stop_reason":"tool_use","content":[{"type":"thinking","thinking":"reviewing codex"}]}}) + "\n")
    handle.write(json.dumps({"type":"assistant","timestamp":"2026-08-02T12:01:02Z","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"claude review"}]}}) + "\n")
PY

node "$LINK" "${ARGS[@]}" --drain >/dev/null
[[ "$(wc -l < "$AGENT_LINK_SEND_LOG")" -eq 2 ]] || fail "return turn did not dispatch exactly once"

python3 - "$AGENT_LINK_SEND_LOG" "$CODEX_LOG" <<'PY'
import json, sys
args = json.loads(open(sys.argv[1], encoding="utf-8").read().splitlines()[-1])
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
[[ "$(wc -l < "$AGENT_LINK_SEND_LOG")" -eq 2 ]] || fail "hop limit allowed a third dispatch"

python3 - "$LINK_STATE" <<'PY'
import json, os, stat, sys
state = json.load(open(sys.argv[1], encoding="utf-8"))
assert state["schema"] == "agent-mesh.session-link.v1"
assert state["outbox"] == []
assert stat.S_IMODE(os.stat(sys.argv[1]).st_mode) == 0o600
PY

# The OpenPack/skill layout loads the copied ESM core without the monorepo.
mkdir -p "$WORKDIR/installed/bin" "$WORKDIR/installed/lib"
cp "$LINK" "$WORKDIR/installed/bin/agent-link.mjs"
cp "$BRIDGE_DIR/../core/src/policy.js" "$WORKDIR/installed/lib/policy.js"
cp "$BRIDGE_DIR/../core/src/session-link.js" "$WORKDIR/installed/lib/session-link.js"
cp "$BRIDGE_DIR/lib/package.json" "$WORKDIR/installed/lib/package.json"
node "$WORKDIR/installed/bin/agent-link.mjs" --help >/dev/null

echo "PASS: bounded session link"
