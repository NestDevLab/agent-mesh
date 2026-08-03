#!/usr/bin/env bash
# Regression test: a busy or uncertain target must not stop the opposite direction.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LINK="$BRIDGE_DIR/bin/agent-link.mjs"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-mesh-link-resilience.XXXXXX")"

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
export AGENT_LINK_SEND_MODE="$WORKDIR/send-mode"
export AGENT_LINK_BUSY_RETRY_MS=1000
mkdir -p "$CODEX_SESSION_ROOT/2026/08/03" "$CLAUDE_SESSION_ROOT/project"
: > "$AGENT_LINK_SEND_LOG"

CODEX_ID="77777777-7777-7777-7777-777777777777"
CLAUDE_ID="88888888-8888-8888-8888-888888888888"
CODEX_LOG="$CODEX_SESSION_ROOT/2026/08/03/rollout-$CODEX_ID.jsonl"
CLAUDE_LOG="$CLAUDE_SESSION_ROOT/project/$CLAUDE_ID.jsonl"
LINK_STATE="$WORKDIR/link-state.json"
FAKE_SEND="$WORKDIR/fake-send.py"
FAKE_WRITER="$WORKDIR/fake-writer.sh"

printf '%s\n' \
    '#!/usr/bin/env python3' \
    'import json, os, sys' \
    'mode = open(os.environ["AGENT_LINK_SEND_MODE"], encoding="utf-8").read().strip()' \
    'target = sys.argv[4]' \
    'with open(os.environ["AGENT_LINK_SEND_LOG"], "a", encoding="utf-8") as handle:' \
    '    handle.write(json.dumps({"mode": mode, "target": target}) + "\n")' \
    'if target == "mesh-claude-main" and mode == "busy":' \
    '    print("BUSY: prompt was not pasted", file=sys.stderr)' \
    '    raise SystemExit(75)' \
    'if target == "mesh-claude-main" and mode == "fail":' \
    '    print("NOT_SUBMITTED: synthetic failure", file=sys.stderr)' \
    '    raise SystemExit(70)' \
    > "$FAKE_SEND"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$FAKE_WRITER"
chmod +x "$FAKE_SEND" "$FAKE_WRITER"
export AGENT_LINK_SEND_BIN="$FAKE_SEND"
export AGENT_LINK_WRITER_STATUS_BIN="$FAKE_WRITER"

printf '%s\n' '{"timestamp":"2026-08-03T07:00:00Z","type":"session_meta","payload":{"id":"codex"}}' > "$CODEX_LOG"
printf '%s\n' '{"type":"system","timestamp":"2026-08-03T07:00:00Z"}' > "$CLAUDE_LOG"
printf '%s\n' busy > "$AGENT_LINK_SEND_MODE"

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

# Codex completes while Claude is busy. The delivery stays pending and consumes
# no attempt because agent-send guaranteed that nothing was pasted.
printf '%s\n' \
    '{"timestamp":"2026-08-03T07:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"codex to busy claude"}}' \
    '{"timestamp":"2026-08-03T07:00:02Z","type":"event_msg","payload":{"type":"task_complete"}}' \
    >> "$CODEX_LOG"
node "$LINK" "${ARGS[@]}" --drain >/dev/null
python3 - "$LINK_STATE" <<'PY'
import json, sys
state = json.load(open(sys.argv[1], encoding="utf-8"))
assert len(state["outbox"]) == 1
delivery = state["outbox"][0]
assert delivery["targetSide"] == "right"
assert delivery["status"] == "pending"
assert delivery["attempts"] == 0
assert delivery["lastDeferred"].startswith("BUSY:")
assert delivery["retryAt"]
PY

# A fresh Claude-local turn targets Codex and must still flow while the opposite
# delivery remains deferred.
printf '%s\n' \
    '{"type":"user","timestamp":"2026-08-03T07:01:00Z","message":{"content":"claude to codex while claude target is busy"}}' \
    '{"type":"assistant","timestamp":"2026-08-03T07:01:01Z","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"claude answer"}]}}' \
    >> "$CLAUDE_LOG"
node "$LINK" "${ARGS[@]}" --drain >/dev/null
python3 - "$AGENT_LINK_SEND_LOG" <<'PY'
import json, sys
records = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8")]
assert sum(record["target"] == "mesh-codex-main" for record in records) == 1
PY

# When the deferred direction later fails after paste, only that direction is
# marked uncertain. Another Claude-local turn must still reach Codex.
sleep 1.1
printf '%s\n' fail > "$AGENT_LINK_SEND_MODE"
node "$LINK" "${ARGS[@]}" --drain >/dev/null
python3 - "$LINK_STATE" <<'PY'
import json, sys
state = json.load(open(sys.argv[1], encoding="utf-8"))
uncertain = [item for item in state["outbox"] if item["targetSide"] == "right"]
assert len(uncertain) == 1
assert uncertain[0]["status"] == "uncertain"
assert uncertain[0]["attempts"] == 1
PY

printf '%s\n' \
    '{"type":"user","timestamp":"2026-08-03T07:02:00Z","message":{"content":"second claude to codex"}}' \
    '{"type":"assistant","timestamp":"2026-08-03T07:02:01Z","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"second claude answer"}]}}' \
    >> "$CLAUDE_LOG"
node "$LINK" "${ARGS[@]}" --drain >/dev/null
python3 - "$AGENT_LINK_SEND_LOG" "$LINK_STATE" <<'PY'
import json, sys
records = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8")]
assert sum(record["target"] == "mesh-codex-main" for record in records) == 2
state = json.load(open(sys.argv[2], encoding="utf-8"))
assert len(state["outbox"]) == 1
assert state["outbox"][0]["targetSide"] == "right"
assert state["outbox"][0]["status"] == "uncertain"
PY

echo "PASS: session-link failures are isolated per target direction"
