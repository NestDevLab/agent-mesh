#!/usr/bin/env bash
# Smoke-test the tmux bridge against a disposable interactive bash session.

set -euo pipefail

# Run on a throwaway, isolated tmux socket so this test can never touch live
# mesh sessions, and so the bridge scripts it invokes use the same server.
export MESH_TMUX_SOCKET="mesh-smoke-test-$$"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="$BRIDGE_DIR/bin"
AGENTS_DIR="$BRIDGE_DIR/agents"

SESSION_BIN="$BIN_DIR/agent-session.sh"
SEND_BIN="$BIN_DIR/agent-send.sh"
READ_BIN="$BIN_DIR/agent-read.sh"

AGENT_NAME="bash-smoke-$$"
TARGET_NAME="mesh-smoke-$$"
SMOKE_CONF="$AGENTS_DIR/${AGENT_NAME}.conf"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-mesh-smoke.XXXXXX")"
TARGET=""

fail() {
    echo "FAIL: $*" >&2
    if [[ -n "${TARGET:-}" ]] && tmux -L "$MESH_TMUX_SOCKET" has-session -t "$TARGET" 2>/dev/null; then
        echo "--- tmux pane: $TARGET ---" >&2
        tmux -L "$MESH_TMUX_SOCKET" capture-pane -t "$TARGET" -p >&2 || true
        echo "--- end pane ---" >&2
    fi
    exit 1
}

cleanup() {
    local status=$?
    trap - EXIT INT TERM

    if [[ -n "${TARGET:-}" ]] && tmux -L "$MESH_TMUX_SOCKET" has-session -t "$TARGET" 2>/dev/null; then
        "$SESSION_BIN" --agent "$AGENT_NAME" kill "$TARGET" >/dev/null 2>&1 \
            || tmux -L "$MESH_TMUX_SOCKET" kill-session -t "$TARGET" 2>/dev/null \
            || true
    fi

    # exit-empty is off on the mesh socket, so the empty server would persist;
    # tear down our isolated socket entirely.
    tmux -L "$MESH_TMUX_SOCKET" kill-server 2>/dev/null || true
    rm -f "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$MESH_TMUX_SOCKET" 2>/dev/null || true

    rm -f "$SMOKE_CONF"
    rm -rf "$WORKDIR"
    exit "$status"
}
trap cleanup EXIT INT TERM

command -v tmux >/dev/null 2>&1 || fail "tmux is required"
[[ -x "$SESSION_BIN" ]] || fail "missing executable: $SESSION_BIN"
[[ -x "$SEND_BIN" ]] || fail "missing executable: $SEND_BIN"
[[ -x "$READ_BIN" ]] || fail "missing executable: $READ_BIN"

send_prompt() {
    local prompt="$1"
    AGENT_POLL_INTERVAL=0.2 AGENT_IDLE_ROUNDS=2 \
        "$SEND_BIN" --agent "$AGENT_NAME" "$TARGET" "$prompt" 10
}

cat > "$SMOKE_CONF" <<'CONF'
AGENT_BIN="bash"
AGENT_SUBMIT_KEY="Enter"
AGENT_PROMPT_CHAR="SMOKE>"
AGENT_WORKING_PATTERN="__agent_mesh_smoke_never_working__"
AGENT_IDLE_PATTERN="SMOKE>"
AGENT_RESUME_CMD="env PS1='SMOKE> ' bash --noprofile --norc -i"
AGENT_HAS_CWD_PICKER="false"
AGENT_PICKER_PATTERN=""
AGENT_NEW_CMD="env PS1='SMOKE> ' bash --noprofile --norc -i"
AGENT_SESSION_DIR="${TMPDIR:-/tmp}"
AGENT_SESSION_CWD_EXTRACTOR='printf "%s\n" "$PWD"'
CONF

TARGET="$("$SESSION_BIN" --agent "$AGENT_NAME" new "$WORKDIR" "$TARGET_NAME")"
[[ "$TARGET" == "$TARGET_NAME" ]] || fail "expected target '$TARGET_NAME', got '$TARGET'"
tmux -L "$MESH_TMUX_SOCKET" has-session -t "$TARGET" 2>/dev/null || fail "tmux session was not created: $TARGET"

status="$("$READ_BIN" --agent "$AGENT_NAME" "$TARGET" --status)"
[[ "$status" == "idle" ]] || fail "expected idle status, got '$status'"

cwd_reply="$(send_prompt "pwd")"
[[ "$cwd_reply" == *"$WORKDIR"* ]] || fail "session cwd was not '$WORKDIR'"

expected="agent-mesh-smoke-ok-$$"
prompt="echo '$expected'"
reply="$(send_prompt "$prompt")"

[[ "$reply" == *"$expected"* ]] || fail "reply did not contain expected output '$expected'"

multiline_expected="agent-mesh-smoke-multiline-$$"
special_expected="agent-mesh-smoke-special-$$ () [] {} \$HOME ; && | < >"
multiline_prompt="$(
    printf "{\nprintf '%%s\\n' '%s'\nprintf '%%s\\n' '%s'\n}" \
        "$multiline_expected" \
        "$special_expected"
)"
multiline_reply="$(send_prompt "$multiline_prompt")"

[[ "$multiline_reply" == *"$multiline_expected"* ]] \
    || fail "multiline reply did not contain expected output '$multiline_expected'"
[[ "$multiline_reply" == *"$special_expected"* ]] \
    || fail "special-char reply did not contain expected output '$special_expected'"

full_output="$("$READ_BIN" --agent "$AGENT_NAME" "$TARGET" --full)"
[[ "$full_output" == *"$expected"* ]] || fail "full pane output did not contain expected output '$expected'"
[[ "$full_output" == *"$multiline_expected"* ]] \
    || fail "full pane output did not contain multiline output '$multiline_expected'"
[[ "$full_output" == *"$special_expected"* ]] \
    || fail "full pane output did not contain special-char output '$special_expected'"

"$SESSION_BIN" --agent "$AGENT_NAME" kill "$TARGET" >/dev/null
TARGET=""

echo "PASS: tmux bridge smoke test"
