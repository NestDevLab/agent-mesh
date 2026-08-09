#!/usr/bin/env bash
# Regression test for first-class launch-option rendering.
# Uses a disposable fake CLI and tmux socket; no agent API is contacted.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="$BRIDGE_DIR/bin"
AGENTS_DIR="$BRIDGE_DIR/agents"
SESSION_BIN="$BIN_DIR/agent-session.sh"
export MESH_TMUX_SOCKET="mesh-launch-options-test-$$"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-mesh-launch-options.XXXXXX")"
FAKE_CLI="$WORKDIR/fake-cli"
LOG_FILE="$WORKDIR/argv"
SUPPORTED_CONF="$AGENTS_DIR/launch-options-supported-$$.conf"
UNSUPPORTED_CONF="$AGENTS_DIR/launch-options-unsupported-$$.conf"
TARGETS=()

cleanup() {
    local status=$?
    trap - EXIT INT TERM
    for target in "${TARGETS[@]}"; do
        "$SESSION_BIN" --agent "launch-options-supported-$$" kill "$target" >/dev/null 2>&1 || true
    done
    tmux -L "$MESH_TMUX_SOCKET" kill-server 2>/dev/null || true
    rm -f "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$MESH_TMUX_SOCKET" 2>/dev/null || true
    rm -f "$SUPPORTED_CONF" "$UNSUPPORTED_CONF"
    rm -rf "$WORKDIR"
    exit "$status"
}
trap cleanup EXIT INT TERM

(
    # Keep the regression tied to the real Claude adapter, not only the
    # synthetic supported fixture below. This must not invoke the Claude CLI.
    # shellcheck source=/dev/null
    source "$AGENTS_DIR/claude.conf"
    [[ "${AGENT_SUPPORTS_MODEL:-false}" == "true" ]] \
        || { echo "FAIL: Claude model support is not enabled" >&2; exit 1; }
    [[ "${AGENT_MODEL_ARGS[*]:-}" == "--model {VALUE}" ]] \
        || { echo "FAIL: Claude model mapping is not '--model {VALUE}'" >&2; exit 1; }
    [[ "${AGENT_SUPPORTS_EFFORT:-false}" == "true" ]] \
        || { echo "FAIL: Claude effort support is not enabled" >&2; exit 1; }
    [[ "${AGENT_EFFORT_ARGS[*]:-}" == "--effort {VALUE}" ]] \
        || { echo "FAIL: Claude effort mapping is not '--effort {VALUE}'" >&2; exit 1; }

    # Keep the accepted Codex policy values and native mapping tied to the
    # real adapter. This must not invoke the Codex CLI.
    # shellcheck source=/dev/null
    source "$AGENTS_DIR/codex.conf"
    [[ "${AGENT_SUPPORTS_APPROVAL_POLICY:-false}" == "true" ]] \
        || { echo "FAIL: Codex approval-policy support is not enabled" >&2; exit 1; }
    [[ "${AGENT_APPROVAL_POLICY_ARGS[*]:-}" == "-a {VALUE}" ]] \
        || { echo "FAIL: Codex approval-policy mapping is not '-a {VALUE}'" >&2; exit 1; }
    [[ "${AGENT_APPROVAL_POLICY_VALUES:-}" == "untrusted on-request never" ]] \
        || { echo "FAIL: Codex approval-policy values are incorrect" >&2; exit 1; }
)

cat > "$FAKE_CLI" <<'CLI'
#!/usr/bin/env bash
printf '%s\0' "$@" > "$FAKE_CLI_LOG"
printf '❯\n'
while :; do sleep 1; done
CLI
chmod +x "$FAKE_CLI"

cat > "$SUPPORTED_CONF" <<CONF
AGENT_BIN="$FAKE_CLI"
AGENT_PROMPT_CHAR="❯"
AGENT_WORKING_PATTERN="__never_working__"
AGENT_IDLE_PATTERN="❯"
AGENT_RESUME_CMD="$FAKE_CLI --resume {SESSION_ID}"
AGENT_NEW_CMD="$FAKE_CLI --new"
AGENT_HAS_CWD_PICKER="false"
AGENT_PICKER_PATTERN=""
AGENT_SESSION_DIR="$WORKDIR"
AGENT_SESSION_CWD_EXTRACTOR='printf "%s\\n" "\$PWD"'
AGENT_SUPPORTS_MODEL="true"
AGENT_MODEL_ARGS=(--model "{VALUE}")
AGENT_SUPPORTS_EFFORT="true"
AGENT_EFFORT_ARGS=(--effort "{VALUE}")
AGENT_SUPPORTS_APPROVAL_POLICY="true"
AGENT_APPROVAL_POLICY_ARGS=(-a "{VALUE}")
AGENT_APPROVAL_POLICY_VALUES="untrusted on-request never"
CONF

cat > "$UNSUPPORTED_CONF" <<CONF
AGENT_BIN="$FAKE_CLI"
AGENT_PROMPT_CHAR="❯"
AGENT_WORKING_PATTERN="__never_working__"
AGENT_IDLE_PATTERN="❯"
AGENT_RESUME_CMD="$FAKE_CLI --resume {SESSION_ID}"
AGENT_NEW_CMD="$FAKE_CLI --new"
AGENT_HAS_CWD_PICKER="false"
AGENT_PICKER_PATTERN=""
AGENT_SESSION_DIR="$WORKDIR"
AGENT_SESSION_CWD_EXTRACTOR='printf "%s\\n" "\$PWD"'
AGENT_SUPPORTS_MODEL="true"
AGENT_MODEL_ARGS=(--model "{VALUE}")
AGENT_SUPPORTS_EFFORT="false"
AGENT_EFFORT_ARGS=()
CONF

export FAKE_CLI_LOG="$LOG_FILE"

assert_argv() {
    local expected="$1"
    [[ "$(tr '\0' ' ' < "$LOG_FILE")" == "$expected" ]] \
        || { echo "FAIL: expected argv '$expected', got '$(tr '\0' ' ' < "$LOG_FILE")'" >&2; exit 1; }
}

run_and_check() {
    local command="$1" target="$2" expected="$3"
    : > "$LOG_FILE"
    if [[ "$command" == "new" ]]; then
        "$SESSION_BIN" --agent "launch-options-supported-$$" \
            --model model-one --effort high --approval-policy never new "$WORKDIR" "$target" \
            -- --model raw-model --effort low >/dev/null
    else
        "$SESSION_BIN" --agent "launch-options-supported-$$" \
            --model model-one --effort high --approval-policy never resume session-123 "$target" \
            -- --model raw-model --effort low >/dev/null
    fi
    TARGETS+=("$target")
    assert_argv "$expected"
}

run_and_check new launch-options-new-$$ \
    "--new --model model-one --effort high -a never --model raw-model --effort low "
run_and_check resume launch-options-resume-$$ \
    "--resume session-123 --model model-one --effort high -a never --model raw-model --effort low "

if "$SESSION_BIN" --agent "launch-options-unsupported-$$" --effort high \
    new "$WORKDIR" launch-options-unsupported-$$ >/dev/null 2>"$WORKDIR/error"; then
    echo "FAIL: unsupported effort unexpectedly succeeded" >&2
    exit 1
fi
grep -q -- "--effort is not supported" "$WORKDIR/error" \
    || { echo "FAIL: unsupported effort did not fail closed" >&2; exit 1; }

if "$SESSION_BIN" --agent "launch-options-supported-$$" --approval-policy on-failure \
    new "$WORKDIR" launch-options-invalid-policy-$$ >/dev/null 2>"$WORKDIR/error"; then
    echo "FAIL: invalid approval policy unexpectedly succeeded" >&2
    exit 1
fi
grep -q -- "invalid --approval-policy 'on-failure'" "$WORKDIR/error" \
    || { echo "FAIL: invalid approval policy did not fail closed" >&2; exit 1; }

echo "PASS: first-class launch-option rendering"
