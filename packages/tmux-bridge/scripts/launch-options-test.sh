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
TRUST_SEND_LOG="$WORKDIR/trust-send.log"
TMUX_REAL="$(command -v tmux)"
TMUX_WRAPPER="$WORKDIR/tmux"
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

cat > "$TMUX_WRAPPER" <<'TMUX'
#!/bin/sh
if [ "$#" -ge 7 ] && [ "$3" = send-keys ] && [ "$6" = "" ] && [ "$7" = Enter ]; then
    printf '%s\n' "$5" >> "${FAKE_TMUX_TRUST_LOG:?}"
fi
exec "${FAKE_TMUX_REAL:?}" "$@"
TMUX
chmod +x "$TMUX_WRAPPER"
export FAKE_TMUX_REAL="$TMUX_REAL" FAKE_TMUX_TRUST_LOG="$TRUST_SEND_LOG"
export PATH="$WORKDIR:$PATH"

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
    [[ "${AGENT_MODEL_PASSTHRU_PATTERNS[*]:-}" == "--model --model=*" ]] \
        || { echo "FAIL: Claude raw model override patterns are incorrect" >&2; exit 1; }
    [[ "${AGENT_EFFORT_PASSTHRU_PATTERNS[*]:-}" == "--effort --effort=*" ]] \
        || { echo "FAIL: Claude raw effort override patterns are incorrect" >&2; exit 1; }

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
    [[ " ${AGENT_MODEL_PASSTHRU_PATTERNS[*]:-} " == *" model=* "* ]] \
        || { echo "FAIL: Codex raw model override pattern is missing" >&2; exit 1; }
    [[ " ${AGENT_EFFORT_PASSTHRU_PATTERNS[*]:-} " == *" model_reasoning_effort=* "* ]] \
        || { echo "FAIL: Codex raw effort override pattern is missing" >&2; exit 1; }
    [[ "$AGENT_NEW_CMD" == *"agents.max_concurrent_threads_per_session=2"* \
        && "$AGENT_RESUME_CMD" == *"agents.max_concurrent_threads_per_session=2"* ]] \
        || { echo "FAIL: governed Codex commands lack the static subagent cap" >&2; exit 1; }
)

(
    export CODEX_NO_REMOTE=1 CODEX_MESH_SUBAGENT_CAP=invalid
    # shellcheck source=/dev/null
    source "$AGENTS_DIR/codex.conf"
    [[ "$AGENT_NEW_CMD" == *"agents.max_concurrent_threads_per_session=2"* \
        && "$AGENT_LAUNCH_WARNING" == *"invalid CODEX_MESH_SUBAGENT_CAP"* ]] \
        || { echo "FAIL: invalid Codex subagent cap did not fail safely" >&2; exit 1; }
)

(
    mkdir -p "$WORKDIR/no-remote-home"
    unset CODEX_REMOTE_SOCK CODEX_NO_REMOTE AGENT_LAUNCH_WARNING
    HOME="$WORKDIR/no-remote-home"
    # shellcheck source=/dev/null
    source "$AGENTS_DIR/codex.conf"
    [[ "${AGENT_LAUNCH_WARNING:-}" == *"standalone tmux-only"* ]] \
        || { echo "FAIL: missing Codex standalone fallback warning" >&2; exit 1; }

    CODEX_NO_REMOTE=1
    source "$AGENTS_DIR/codex.conf"
    [[ -z "${AGENT_LAUNCH_WARNING:-}" ]] \
        || { echo "FAIL: explicit Codex standalone mode should not warn" >&2; exit 1; }
)

cat > "$FAKE_CLI" <<'CLI'
#!/usr/bin/env bash
printf '%s\0' "$@" > "$FAKE_CLI_LOG"
trust_request="${FAKE_CLI_LOG%/*}/trust-request"
if [[ -f "$trust_request" ]]; then
    case "$(cat "$trust_request")" in
        marker-absent)
            printf 'Do you trust the contents of this directory?\n'
            printf '  1. Yes, continue\n'
            printf '  2. No, exit\n'
            ;;
        option-two)
            printf 'Do you trust the contents of this directory?\n'
            printf '> 2. No, exit\n'
            printf '  1. Yes, continue\n'
            ;;
        *)
            printf 'Do you trust the contents of this directory?\n'
            printf '> 1. Yes, continue\n'
            printf '  2. No, exit\n'
            IFS= read -r _confirmation
            printf '\033[2J\033[H'
            ;;
    esac
fi
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
AGENT_MODEL_PASSTHRU_PATTERNS=(--model "--model=*")
AGENT_SUPPORTS_EFFORT="true"
AGENT_EFFORT_ARGS=(--effort "{VALUE}")
AGENT_EFFORT_PASSTHRU_PATTERNS=(--effort "--effort=*")
AGENT_PIN_ENABLE_ENV="FAKE_MESH_PIN"
AGENT_PIN_DEFAULT_MODEL="default-model"
AGENT_PIN_DEFAULT_EFFORT="medium"
AGENT_PIN_MODEL_ENV="FAKE_MESH_MODEL"
AGENT_PIN_EFFORT_ENV="FAKE_MESH_EFFORT"
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
    "--new -a never --model raw-model --effort low "
run_and_check resume launch-options-resume-$$ \
    "--resume session-123 -a never --model raw-model --effort low "

# A later invocation must rebuild its launch options from scratch. This proves
# the preceding raw flags cannot leak into a new spawn.
: > "$LOG_FILE"
default_target="launch-options-default-after-raw-$$"
"$SESSION_BIN" --agent "launch-options-supported-$$" \
    new "$WORKDIR" "$default_target" >/dev/null
TARGETS+=("$default_target")
assert_argv "--new --model default-model --effort medium "

: > "$LOG_FILE"
first_class_target="launch-options-first-class-$$"
"$SESSION_BIN" --agent "launch-options-supported-$$" \
    --model model-one --effort high new "$WORKDIR" "$first_class_target" >/dev/null
TARGETS+=("$first_class_target")
assert_argv "--new --model model-one --effort high "

# Codex's current cwd trust dialog must confirm only a visible default first
# option. Marker-absent and option-two dialogs remain unanswered.
trust_request="$WORKDIR/trust-request"
run_trust_case() {
    local mode="$1" target
    target="launch-options-codex-trust-$mode-$$"
    printf '%s\n' "$mode" > "$trust_request"
    : > "$TRUST_SEND_LOG"
    "$SESSION_BIN" --agent "launch-options-supported-$$" \
        new "$WORKDIR" "$target" >/dev/null
    TARGETS+=("$target")
    if [[ "$mode" == "default-first" ]]; then
        grep -Fxq "$target" "$TRUST_SEND_LOG" \
            || { echo "FAIL: Codex default first trust option was not confirmed" >&2; exit 1; }
    else
        ! grep -Fxq "$target" "$TRUST_SEND_LOG" \
            || { echo "FAIL: Codex trust dialog '$mode' was auto-confirmed" >&2; exit 1; }
    fi
}
run_trust_case marker-absent
run_trust_case option-two
run_trust_case default-first

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
