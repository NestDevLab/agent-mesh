#!/usr/bin/env bash
# Regression test: never paste a linked turn into an agent that is already busy.

set -euo pipefail

export MESH_TMUX_SOCKET="mesh-send-readiness-test-$$"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SEND_BIN="$BRIDGE_DIR/bin/agent-send.sh"
AGENTS_DIR="$BRIDGE_DIR/agents"
AGENT_NAME="busy-test-$$"
TARGET="mesh-busy-test-$$"
CONF="$AGENTS_DIR/${AGENT_NAME}.conf"
PROMPT="PROMPT-MUST-NOT-BE-PASTED-$$"

cleanup() {
    local status=$?
    trap - EXIT INT TERM
    tmux -L "$MESH_TMUX_SOCKET" kill-server 2>/dev/null || true
    rm -f "$CONF"
    exit "$status"
}
trap cleanup EXIT INT TERM

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

cat > "$CONF" <<'CONF'
AGENT_BIN="bash"
AGENT_SUBMIT_KEY="Enter"
AGENT_PROMPT_CHAR="READY>"
AGENT_WORKING_PATTERN="Working"
AGENT_IDLE_PATTERN="READY>"
AGENT_ALIVE_PATTERN="Working|READY>"
CONF

tmux -L "$MESH_TMUX_SOCKET" new-session -d -s "$TARGET" \
    "bash -c 'while true; do echo Working; sleep 0.1; done'"

set +e
output="$("$SEND_BIN" --quiet --agent "$AGENT_NAME" "$TARGET" "$PROMPT" 2 2>&1)"
status=$?
set -e

[[ "$status" -eq 75 ]] || fail "expected busy exit 75, got $status ($output)"
[[ "$output" == *"prompt was not pasted"* ]] || fail "busy result omitted no-paste guarantee"
pane="$(tmux -L "$MESH_TMUX_SOCKET" capture-pane -t "$TARGET" -p)"
[[ "$pane" != *"$PROMPT"* ]] || fail "busy target received the prompt"

echo "PASS: busy agent send is deferred before paste"
