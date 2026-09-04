#!/usr/bin/env bash
# Regression test for the "tmux server self-terminated and killed a live agent
# session" incident.
#
# Root cause: the bridge used the shared DEFAULT tmux server, where `exit-empty`
# is `on` by default — so the moment the server had zero sessions (e.g. a
# concurrent smoke test killed its last transient session) the whole server, and
# every live agent session on it, was destroyed.
#
# This test asserts the three invariants the fix must hold:
#   A. mesh sessions live on a DEDICATED socket, not the user's default server;
#   B. that mesh server has `exit-empty off` (never self-destructs when empty);
#   C. a live session survives while another session is created and killed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="$BRIDGE_DIR/bin"
AGENTS_DIR="${AGENT_MESH_AGENTS_DIR:-$BRIDGE_DIR/agents}"

SESSION_BIN="$BIN_DIR/agent-session.sh"

# Isolate THIS test onto its own throwaway socket so it can never touch real
# mesh sessions, and so the assertions are about the bridge's socket behavior.
export MESH_TMUX_SOCKET="mesh-isolation-test-$$"

AGENT_NAME="bash-iso-$$"
SMOKE_CONF="$AGENTS_DIR/${AGENT_NAME}.conf"
LIVE_TARGET="iso-live-$$"
TRANSIENT_TARGET="iso-transient-$$"

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

cleanup() {
    local status=$?
    trap - EXIT INT TERM
    tmux -L "$MESH_TMUX_SOCKET" kill-server 2>/dev/null || true
    rm -f "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$MESH_TMUX_SOCKET" 2>/dev/null || true
    rm -f "$SMOKE_CONF"
    exit "$status"
}
trap cleanup EXIT INT TERM

command -v tmux >/dev/null 2>&1 || fail "tmux is required"
[[ -x "$SESSION_BIN" ]] || fail "missing executable: $SESSION_BIN"

cat > "$SMOKE_CONF" <<'CONF'
AGENT_BIN="bash"
AGENT_SUBMIT_KEY="Enter"
AGENT_PROMPT_CHAR="ISO>"
AGENT_WORKING_PATTERN="__agent_mesh_iso_never_working__"
AGENT_IDLE_PATTERN="ISO>"
AGENT_RESUME_CMD="env PS1='ISO> ' bash --noprofile --norc -i"
AGENT_HAS_CWD_PICKER="false"
AGENT_PICKER_PATTERN=""
AGENT_NEW_CMD="env PS1='ISO> ' bash --noprofile --norc -i"
AGENT_SESSION_DIR="${TMPDIR:-/tmp}"
AGENT_SESSION_CWD_EXTRACTOR='printf "%s\n" "$PWD"'
CONF

# Start a long-lived session through the bridge.
"$SESSION_BIN" --agent "$AGENT_NAME" new "${TMPDIR:-/tmp}" "$LIVE_TARGET" >/dev/null

# A. The session must live on the dedicated mesh socket, NOT the default server.
tmux -L "$MESH_TMUX_SOCKET" has-session -t "$LIVE_TARGET" 2>/dev/null \
    || fail "live session is not on the dedicated mesh socket '$MESH_TMUX_SOCKET'"
if tmux has-session -t "$LIVE_TARGET" 2>/dev/null; then
    fail "live session leaked onto the DEFAULT tmux server (no isolation)"
fi

# B. The mesh server must have exit-empty off so it never self-destructs.
exit_empty="$(tmux -L "$MESH_TMUX_SOCKET" show-options -s exit-empty 2>/dev/null | awk '{print $2}')"
[[ "$exit_empty" == "off" ]] \
    || fail "mesh server exit-empty is '$exit_empty', expected 'off'"

# C. Create and kill a transient session; the live session must survive.
"$SESSION_BIN" --agent "$AGENT_NAME" new "${TMPDIR:-/tmp}" "$TRANSIENT_TARGET" >/dev/null
"$SESSION_BIN" --agent "$AGENT_NAME" kill "$TRANSIENT_TARGET" >/dev/null
tmux -L "$MESH_TMUX_SOCKET" has-session -t "$LIVE_TARGET" 2>/dev/null \
    || fail "live session was destroyed when a transient session was killed"

"$SESSION_BIN" --agent "$AGENT_NAME" kill "$LIVE_TARGET" >/dev/null

echo "PASS: tmux socket isolation regression test"
