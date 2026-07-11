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
# shellcheck source=../bin/_mesh-tmux.sh
source "$BIN_DIR/_mesh-tmux.sh"

SESSION_BIN="$BIN_DIR/agent-session.sh"
SEND_BIN="$BIN_DIR/agent-send.sh"
READ_BIN="$BIN_DIR/agent-read.sh"
WAIT_BIN="$BIN_DIR/agent-wait.sh"

AGENT_NAME="bash-smoke-$$"
WAIT_AGENT_NAME="bash-wait-smoke-$$"
TARGET_NAME="mesh-smoke-$$"
TITLE_TEXT=": agent-mesh-smoke-title-$$"
SMOKE_CONF="$AGENTS_DIR/${AGENT_NAME}.conf"
WAIT_CONF="$AGENTS_DIR/${WAIT_AGENT_NAME}.conf"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-mesh-smoke.XXXXXX")"
TARGET=""
PROGRESS_TARGET=""
STALLED_TARGET=""

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
    if [[ -n "${PROGRESS_TARGET:-}" ]] && tmux -L "$MESH_TMUX_SOCKET" has-session -t "$PROGRESS_TARGET" 2>/dev/null; then
        tmux -L "$MESH_TMUX_SOCKET" kill-session -t "$PROGRESS_TARGET" 2>/dev/null || true
    fi
    if [[ -n "${STALLED_TARGET:-}" ]] && tmux -L "$MESH_TMUX_SOCKET" has-session -t "$STALLED_TARGET" 2>/dev/null; then
        tmux -L "$MESH_TMUX_SOCKET" kill-session -t "$STALLED_TARGET" 2>/dev/null || true
    fi

    # exit-empty is off on the mesh socket, so the empty server would persist;
    # tear down our isolated socket entirely.
    tmux -L "$MESH_TMUX_SOCKET" kill-server 2>/dev/null || true
    rm -f "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$MESH_TMUX_SOCKET" 2>/dev/null || true

    rm -f "$SMOKE_CONF" "$WAIT_CONF"
    rm -rf "$WORKDIR"
    exit "$status"
}
trap cleanup EXIT INT TERM

command -v tmux >/dev/null 2>&1 || fail "tmux is required"
[[ -x "$SESSION_BIN" ]] || fail "missing executable: $SESSION_BIN"
[[ -x "$SEND_BIN" ]] || fail "missing executable: $SEND_BIN"
[[ -x "$READ_BIN" ]] || fail "missing executable: $READ_BIN"
[[ -x "$WAIT_BIN" ]] || fail "missing executable: $WAIT_BIN"

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
AGENT_SUPPORTS_LAUNCH_TITLE="true"
CONF

cat > "$WAIT_CONF" <<'CONF'
AGENT_BIN="bash"
AGENT_SUBMIT_KEY="Enter"
AGENT_PROMPT_CHAR="WAIT>"
AGENT_WORKING_PATTERN="Working"
AGENT_IDLE_PATTERN="WAIT>"
AGENT_RESUME_CMD="env PS1='WAIT> ' bash --noprofile --norc -i"
AGENT_HAS_CWD_PICKER="false"
AGENT_PICKER_PATTERN=""
AGENT_NEW_CMD="env PS1='WAIT> ' bash --noprofile --norc -i"
AGENT_SESSION_DIR="${TMPDIR:-/tmp}"
AGENT_SESSION_CWD_EXTRACTOR='printf "%s\n" "$PWD"'
CONF

TARGET="$("$SESSION_BIN" --agent "$AGENT_NAME" --title "$TITLE_TEXT" new "$WORKDIR" "$TARGET_NAME")"
[[ "$TARGET" == "$TARGET_NAME" ]] || fail "expected target '$TARGET_NAME', got '$TARGET'"
tmux -L "$MESH_TMUX_SOCKET" has-session -t "$TARGET" 2>/dev/null || fail "tmux session was not created: $TARGET"
[[ -s "$(mesh_pending_title_file "$TARGET")" ]] || fail "pending launch title was not recorded"

status="$("$READ_BIN" --agent "$AGENT_NAME" "$TARGET" --status)"
[[ "$status" == "idle" ]] || fail "expected idle status, got '$status'"

cwd_reply="$(send_prompt "pwd")"
[[ "$cwd_reply" == *"$WORKDIR"* ]] || fail "session cwd was not '$WORKDIR'"
[[ ! -e "$(mesh_pending_title_file "$TARGET")" ]] || fail "pending launch title was not consumed"
first_send_output="$("$READ_BIN" --agent "$AGENT_NAME" "$TARGET" --full)"
title_count="$(grep -cF "$TITLE_TEXT" <<<"$first_send_output" || true)"
[[ "$title_count" -eq 1 ]] || fail "launch title should be injected once, got $title_count occurrences"

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

PROGRESS_TARGET="mesh-smoke-progress-$$"
tmux -L "$MESH_TMUX_SOCKET" new-session -d -s "$PROGRESS_TARGET" "while true; do echo Working; sleep 0.2; done"
set +e
progress_state="$("$WAIT_BIN" --agent "$WAIT_AGENT_NAME" "$PROGRESS_TARGET" --timeout 2 --poll 1 --stall 5)"
progress_rc=$?
set -e
[[ "$progress_rc" -eq 4 ]] || fail "expected progress exit 4, got $progress_rc ($progress_state)"
[[ "$progress_state" == progress* ]] || fail "expected progress state, got '$progress_state'"
tmux -L "$MESH_TMUX_SOCKET" kill-session -t "$PROGRESS_TARGET"
PROGRESS_TARGET=""

STALLED_TARGET="mesh-smoke-stalled-$$"
tmux -L "$MESH_TMUX_SOCKET" new-session -d -s "$STALLED_TARGET" "sleep 100"
set +e
stalled_state="$("$WAIT_BIN" --agent "$WAIT_AGENT_NAME" "$STALLED_TARGET" --timeout 2 --poll 1 --stall 1)"
stalled_rc=$?
set -e
[[ "$stalled_rc" -eq 124 ]] || fail "expected stalled exit 124, got $stalled_rc ($stalled_state)"
[[ "$stalled_state" == stalled* ]] || fail "expected stalled state, got '$stalled_state'"
tmux -L "$MESH_TMUX_SOCKET" kill-session -t "$STALLED_TARGET"
STALLED_TARGET=""

"$SESSION_BIN" --agent "$AGENT_NAME" kill "$TARGET" >/dev/null
TARGET=""

echo "PASS: tmux bridge smoke test"
