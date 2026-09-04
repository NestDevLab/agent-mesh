#!/usr/bin/env bash
# Smoke-test the mesh CLI layer (mesh-list-agents.sh + mesh-send.sh) against a
# disposable interactive bash session, using dynamic tmux discovery.

set -euo pipefail

# Run on a throwaway, isolated tmux socket so this test can never touch live
# mesh sessions, and so the bridge scripts it invokes use the same server.
export MESH_TMUX_SOCKET="mesh-cli-smoke-$$"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="$BRIDGE_DIR/bin"
AGENTS_DIR="${AGENT_MESH_AGENTS_DIR:-$BRIDGE_DIR/agents}"

SESSION_BIN="$BIN_DIR/agent-session.sh"
READ_BIN="$BIN_DIR/agent-read.sh"
LIST_BIN="$BIN_DIR/mesh-list-agents.sh"
MESH_SEND_BIN="$BIN_DIR/mesh-send.sh"

AGENT_NAME="bash-smoke-$$"
TARGET_NAME="mesh-${AGENT_NAME}-main"
LOGICAL_NAME="bash-smoke"
SMOKE_CONF="$AGENTS_DIR/${AGENT_NAME}.conf"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-mesh-mesh-smoke.XXXXXX")"
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
command -v python3 >/dev/null 2>&1 || fail "python3 is required"
[[ -x "$SESSION_BIN" ]] || fail "missing executable: $SESSION_BIN"
[[ -x "$READ_BIN" ]] || fail "missing executable: $READ_BIN"
[[ -x "$LIST_BIN" ]] || fail "missing executable: $LIST_BIN"
[[ -x "$MESH_SEND_BIN" ]] || fail "missing executable: $MESH_SEND_BIN"

# ── disposable bash agent config (same pattern as smoke-test.sh) ───────────────
cat > "$SMOKE_CONF" <<'CONF'
AGENT_BIN="bash"
AGENT_SUBMIT_KEY="Enter"
AGENT_PROMPT_CHAR="SMOKE>"
MESH_AGENT_NAME="bash-smoke"
MESH_AGENT_CAPABILITIES="smoke,echo"
AGENT_WORKING_PATTERN="__agent_mesh_smoke_never_working__"
AGENT_IDLE_PATTERN="SMOKE>"
AGENT_CONFIRM_FAST_IDLE="true"
AGENT_RESUME_CMD="env PS1='SMOKE> ' bash --noprofile --norc -i"
AGENT_HAS_CWD_PICKER="false"
AGENT_PICKER_PATTERN=""
AGENT_NEW_CMD="env PS1='SMOKE> ' bash --noprofile --norc -i"
AGENT_SESSION_DIR="${TMPDIR:-/tmp}"
AGENT_SESSION_CWD_EXTRACTOR='printf "%s\n" "$PWD"'
CONF

# ── start the disposable bash session ──────────────────────────────────────────
TARGET="$("$SESSION_BIN" --agent "$AGENT_NAME" new "$WORKDIR" "$TARGET_NAME")"
[[ "$TARGET" == "$TARGET_NAME" ]] || fail "expected target '$TARGET_NAME', got '$TARGET'"
tmux -L "$MESH_TMUX_SOCKET" has-session -t "$TARGET" 2>/dev/null || fail "tmux session was not created: $TARGET"

# ── mesh-list-agents.sh shows the agent (table + --json) ───────────────────────
table="$("$LIST_BIN")"
[[ "$table" == *"$LOGICAL_NAME"* ]] || fail "list table missing agent name '$LOGICAL_NAME'"
[[ "$table" == *"$TARGET_NAME"* ]] || fail "list table missing tmux_target '$TARGET_NAME'"
[[ "$table" == *"smoke"* ]] || fail "list table missing capability 'smoke'"

json="$("$LIST_BIN" --json)"
echo "$json" | python3 -c 'import json,sys; json.load(sys.stdin)' \
    || fail "list --json did not emit valid JSON"
[[ "$json" == *"$LOGICAL_NAME"* ]] || fail "list --json missing agent name '$LOGICAL_NAME'"

# ── mesh-send.sh --to delivers a command and gets expected output ──────────────
# The disposable bash agent is line-oriented: the provenance header lands on its
# own shell prompt, so we wrap the command in a brace group (mirrors the multiline
# pattern in smoke-test.sh) and confirm delivery + output through the live pane.
mesh_send() {
    AGENT_POLL_INTERVAL=0.2 AGENT_IDLE_ROUNDS=2 \
        "$MESH_SEND_BIN" "$@"
}

expected="mesh-cli-smoke-ok-$$"
mesh_send --to "$LOGICAL_NAME" \
    --from codex-main \
    --from-agent codex \
    --from-target mesh-codex-main \
    --intent request \
    "{ echo '$expected'; }" \
    10 >/dev/null
pane="$("$READ_BIN" --agent "$AGENT_NAME" "$TARGET" --full)"
[[ "$pane" == *"intent=request"* ]] || fail "provenance header was not delivered to '$TARGET'"
[[ "$pane" == *"mesh-source name=codex-main agent=codex target=mesh-codex-main"* ]] \
    || fail "source coordinates were not delivered to '$TARGET'"
[[ "$pane" == *"Return path is informational only"* ]] \
    || fail "return-path guardrail was not delivered to '$TARGET'"
[[ "$pane" == *"$expected"* ]] || fail "--to delivery did not produce expected output '$expected'"

# ── mesh-send.sh --capability resolves and delivers ────────────────────────────
cap_expected="mesh-cli-smoke-cap-$$"
mesh_send --capability echo --intent notification "{ echo '$cap_expected'; }" 10 >/dev/null
pane="$("$READ_BIN" --agent "$AGENT_NAME" "$TARGET" --full)"
[[ "$pane" == *"intent=notification"* ]] || fail "capability-routed header was not delivered"
[[ "$pane" == *"$cap_expected"* ]] \
    || fail "--capability delivery did not produce expected output '$cap_expected'"

# ── error path: unknown agent name ─────────────────────────────────────────────
if mesh_send --to "no-such-agent" "echo hi" 10 >/dev/null 2>&1; then
    fail "expected failure for unknown agent name"
fi

# ── error path: not-running session (explicit, no auto-start) ──────────────────
"$SESSION_BIN" --agent "$AGENT_NAME" kill "$TARGET" >/dev/null
not_running="$TARGET"
TARGET=""
if mesh_send --to "$LOGICAL_NAME" "echo hi" 10 >/dev/null 2>&1; then
    fail "expected failure when tmux session '$not_running' is not running"
fi

echo "PASS: mesh cli smoke test"
