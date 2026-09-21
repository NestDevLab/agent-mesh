#!/usr/bin/env bash
# Regression test for first-class launch-option rendering.
# Uses a disposable fake CLI and tmux socket; no agent API is contacted.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="$BRIDGE_DIR/bin"
AGENTS_DIR="${AGENT_MESH_AGENTS_DIR:-$BRIDGE_DIR/agents}"
SESSION_BIN="$BIN_DIR/agent-session.sh"
export MESH_TMUX_SOCKET="mesh-launch-options-test-$$"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-mesh-launch-options.XXXXXX")"
FAKE_CLI="$WORKDIR/fake-cli"
LOG_FILE="$WORKDIR/argv"
export FAKE_CLI_CWD_LOG="$WORKDIR/resume-cwd"
TRUST_SEND_LOG="$WORKDIR/trust-send.log"
TMUX_REAL="$(command -v tmux)"
TMUX_WRAPPER="$WORKDIR/tmux"
SUPPORTED_CONF="$AGENTS_DIR/launch-options-supported-$$.conf"
UNSUPPORTED_CONF="$AGENTS_DIR/launch-options-unsupported-$$.conf"
RESUME_CONF="$AGENTS_DIR/launch-options-resume-cwd-$$.conf"
TARGETS=()

cleanup() {
    local status=$?
    trap - EXIT INT TERM
    for target in "${TARGETS[@]}"; do
        "$SESSION_BIN" --agent "launch-options-supported-$$" kill "$target" >/dev/null 2>&1 || true
    done
    tmux -L "$MESH_TMUX_SOCKET" kill-server 2>/dev/null || true
    rm -f "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$MESH_TMUX_SOCKET" 2>/dev/null || true
    rm -f "$SUPPORTED_CONF" "$UNSUPPORTED_CONF" "$RESUME_CONF"
    rm -rf "$WORKDIR"
    exit "$status"
}
trap cleanup EXIT INT TERM

cat > "$TMUX_WRAPPER" <<'TMUX'
#!/bin/sh
if [ "$#" -ge 6 ] && [ "$3" = send-keys ]; then
    printf '%s\t%s\t%s\n' "$5" "$6" "${7:-}" >> "${FAKE_TMUX_TRUST_LOG:?}"
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

    claude_session_dir="$WORKDIR/-srv-workspace-acme-app"
    claude_session_file="$claude_session_dir/11111111-1111-4111-8111-111111111111.jsonl"
    mkdir -p "$claude_session_dir"
    : > "$claude_session_file"
    claude_session_cwd="$(eval "$AGENT_SESSION_CWD_EXTRACTOR \"$claude_session_file\"")"
    [[ "$claude_session_cwd" == "/srv/workspace/acme/app" ]] \
        || { echo "FAIL: Claude cwd extraction returned '$claude_session_cwd'" >&2; exit 1; }

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
[[ -z "${FAKE_CLI_CWD_LOG:-}" ]] || pwd -P > "$FAKE_CLI_CWD_LOG"
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
        claude-current)
            printf 'Quick safety check: Is this a project you created or one you trust?\n'
            printf '❯ No, exit\n'
            printf '  Yes, I trust this folder\n'
            printf 'Enter to confirm · Esc to cancel\n'
            IFS= read -rsn3 _navigation
            printf '\033[2J\033[H'
            printf 'Quick safety check: Is this a project you created or one you trust?\n'
            printf '  No, exit\n'
            printf '❯ Yes, I trust this folder\n'
            printf 'Enter to confirm · Esc to cancel\n'
            IFS= read -r _confirmation
            printf '\033[2J\033[H'
            ;;
        claude-transient)
            printf 'Quick safety check: Is this a project you created or one you trust?\n'
            printf 'Rendering options...\n'
            sleep 2
            printf '\033[2J\033[H'
            printf 'Quick safety check: Is this a project you created or one you trust?\n'
            printf '❯ No, exit\n'
            printf '  Yes, I trust this folder\n'
            printf 'Enter to confirm · Esc to cancel\n'
            IFS= read -rsn3 _navigation
            printf '\033[2J\033[H'
            printf 'Quick safety check: Is this a project you created or one you trust?\n'
            printf '  No, exit\n'
            printf '❯ Yes, I trust this folder\n'
            printf 'Enter to confirm · Esc to cancel\n'
            IFS= read -r _confirmation
            printf '\033[2J\033[H'
            ;;
        claude-backstop)
            printf 'Quick safety check: Is this a project you created or one you trust?\n'
            printf '❯ No, continue without these permissions\n'
            printf '  Yes, I trust this folder\n'
            printf 'Enter to confirm · Esc to cancel\n'
            IFS= read -rsn3 _navigation
            printf '\033[2J\033[H'
            printf 'Quick safety check: Is this a project you created or one you trust?\n'
            printf '  No, continue without these permissions\n'
            printf '❯ Yes, I trust this folder\n'
            printf 'Enter to confirm · Esc to cancel\n'
            IFS= read -r _confirmation
            printf '\033[2J\033[H'
            ;;
        claude-unknown)
            printf 'Is this a project you trust?\n'
            printf '❯ No, leave\n'
            printf '  Trust this workspace\n'
            printf 'Enter to confirm · Esc to cancel\n'
            ;;
        terminal-reconnect)
            printf 'Reconnect failed — check the endpoint, then relaunch\n'
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
AGENT_TRUST_DIALOG_KIND="codex"
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

# Claude's persisted project directory must be the tmux cwd before the CLI
# starts. A missing session file must not create a target or send any key.
resume_id="22222222-2222-4222-8222-222222222222"
resume_project="$WORKDIR/sessions/project-dir"
mkdir -p "$resume_project"
: > "$resume_project/$resume_id.jsonl"
cat > "$RESUME_CONF" <<CONF
AGENT_BIN="$FAKE_CLI"
AGENT_PROMPT_CHAR="❯"
AGENT_WORKING_PATTERN="__never_working__"
AGENT_IDLE_PATTERN="❯"
AGENT_RESUME_CMD="$FAKE_CLI --resume {SESSION_ID}"
AGENT_HAS_CWD_PICKER="false"
AGENT_PICKER_PATTERN=""
AGENT_SESSION_DIR="$WORKDIR/sessions"
AGENT_SESSION_CWD_EXTRACTOR='dirname'
AGENT_RESUME_IN_SESSION_CWD="true"
CONF
resume_target="launch-options-resume-cwd-$$"
"$SESSION_BIN" --agent "launch-options-resume-cwd-$$" \
    resume "$resume_id" "$resume_target" >/dev/null
TARGETS+=("$resume_target")
[[ "$(< "$FAKE_CLI_CWD_LOG")" == "$resume_project" ]] \
    || { echo "FAIL: resumed Claude did not start in its persisted project directory" >&2; exit 1; }
missing_target="launch-options-resume-missing-$$"
if "$SESSION_BIN" --agent "launch-options-resume-cwd-$$" \
    resume 33333333-3333-4333-8333-333333333333 "$missing_target" \
    >"$WORKDIR/missing-out" 2>"$WORKDIR/missing-error"; then
    echo "FAIL: missing Claude session file returned a usable target" >&2
    exit 1
fi
! tmux -L "$MESH_TMUX_SOCKET" has-session -t "$missing_target" 2>/dev/null \
    || { echo "FAIL: missing Claude session file created a target" >&2; exit 1; }

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

# Claude Remote Control is an explicit passthrough option. Both supported spellings
# must remain one argv element, after the bridge's configured launch options.
for remote_flag in --remote-control --rc; do
    : > "$LOG_FILE"
    remote_target="launch-options-claude-remote-${remote_flag#--}-$$"
    "$SESSION_BIN" --agent "launch-options-supported-$$" \
        new "$WORKDIR" "$remote_target" -- "$remote_flag" >/dev/null
    TARGETS+=("$remote_target")
    assert_argv "--new --model default-model --effort medium $remote_flag "
done

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
        grep -Fqx "$target"$'\t\t'"Enter" "$TRUST_SEND_LOG" \
            || { echo "FAIL: Codex default first trust option was not confirmed" >&2; exit 1; }
    else
        ! grep -Fqx "$target"$'\t\t'"Enter" "$TRUST_SEND_LOG" \
            || { echo "FAIL: Codex trust dialog '$mode' was auto-confirmed" >&2; exit 1; }
    fi
}
run_trust_case marker-absent
run_trust_case option-two
run_trust_case default-first

# Claude 2.1.252+ starts on "No, exit". The bridge must move to the exact
# trust label, re-read the dialog, and only then confirm. Unknown layouts fail
# without returning a usable target.
sed 's/AGENT_TRUST_DIALOG_KIND="codex"/AGENT_TRUST_DIALOG_KIND="claude"/' \
    "$SUPPORTED_CONF" > "$UNSUPPORTED_CONF"
printf '%s\n' claude-current > "$trust_request"
: > "$TRUST_SEND_LOG"
claude_target="launch-options-claude-trust-current-$$"
"$SESSION_BIN" --agent "launch-options-unsupported-$$" \
    new "$WORKDIR" "$claude_target" >/dev/null
TARGETS+=("$claude_target")
grep -Fqx "$claude_target"$'\t'"Down"$'\t' "$TRUST_SEND_LOG" \
    || { echo "FAIL: Claude trust handler did not select the trust option" >&2; exit 1; }
grep -Fqx "$claude_target"$'\t\t'"Enter" "$TRUST_SEND_LOG" \
    || { echo "FAIL: Claude trust handler did not confirm the selected trust option" >&2; exit 1; }

printf '%s\n' claude-transient > "$trust_request"
: > "$TRUST_SEND_LOG"
transient_target="launch-options-claude-trust-transient-$$"
"$SESSION_BIN" --agent "launch-options-unsupported-$$" \
    new "$WORKDIR" "$transient_target" >/dev/null
TARGETS+=("$transient_target")
grep -Fqx "$transient_target"$'\t'"Down"$'\t' "$TRUST_SEND_LOG" \
    || { echo "FAIL: transient Claude trust dialog was not selected after completing" >&2; exit 1; }
grep -Fqx "$transient_target"$'\t\t'"Enter" "$TRUST_SEND_LOG" \
    || { echo "FAIL: transient Claude trust dialog was not confirmed after completing" >&2; exit 1; }

printf '%s\n' claude-backstop > "$trust_request"
: > "$TRUST_SEND_LOG"
backstop_target="launch-options-claude-trust-backstop-$$"
"$SESSION_BIN" --agent "launch-options-unsupported-$$" \
    new "$WORKDIR" "$backstop_target" >/dev/null
TARGETS+=("$backstop_target")
grep -Fqx "$backstop_target"$'\t'"Down"$'\t' "$TRUST_SEND_LOG" \
    || { echo "FAIL: Claude backstop trust handler did not select the trust option" >&2; exit 1; }
grep -Fqx "$backstop_target"$'\t\t'"Enter" "$TRUST_SEND_LOG" \
    || { echo "FAIL: Claude backstop trust handler did not confirm the selected trust option" >&2; exit 1; }

printf '%s\n' claude-unknown > "$trust_request"
: > "$TRUST_SEND_LOG"
unknown_target="launch-options-claude-trust-unknown-$$"
if "$SESSION_BIN" --agent "launch-options-unsupported-$$" \
    new "$WORKDIR" "$unknown_target" >"$WORKDIR/unknown-out" 2>"$WORKDIR/unknown-error"; then
    echo "FAIL: unknown Claude trust layout returned a usable target" >&2
    exit 1
fi
! grep -Fq "$unknown_target"$'\t\t'"Enter" "$TRUST_SEND_LOG" \
    || { echo "FAIL: unknown Claude trust layout was blindly confirmed" >&2; exit 1; }
grep -q "unrecognized Claude trust dialog" "$WORKDIR/unknown-error" \
    || { echo "FAIL: unknown Claude trust layout lacked a precise error" >&2; exit 1; }

# A strict MCP resume reports a category, not a copied pane, before retiring
# only its own newly created and still-unsent target.
printf '%s\n' terminal-reconnect > "$trust_request"
reconnect_target="launch-options-terminal-reconnect-$$"
if MESH_STRICT_READY=1 "$SESSION_BIN" --agent "launch-options-unsupported-$$" \
    resume 11111111-1111-4111-8111-111111111111 "$reconnect_target" \
    >"$WORKDIR/reconnect-out" 2>"$WORKDIR/reconnect-error"; then
    echo "FAIL: terminal reconnect returned a usable target" >&2
    exit 1
fi
grep -q 'reason=terminal_reconnect_failure' "$WORKDIR/reconnect-error" \
    || { echo "FAIL: strict resume omitted redacted failure category" >&2; exit 1; }
! grep -q 'Reconnect failed — check the endpoint' "$WORKDIR/reconnect-error" \
    || { echo "FAIL: strict resume copied raw pane text to stderr" >&2; exit 1; }
! tmux -L "$MESH_TMUX_SOCKET" has-session -t "$reconnect_target" 2>/dev/null \
    || { echo "FAIL: unready unsent target was retained" >&2; exit 1; }

# Restore the unsupported-effort fixture used below.
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
