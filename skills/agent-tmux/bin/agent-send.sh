#!/bin/bash
# agent-send.sh — Send a prompt to an AI agent CLI running in tmux, wait for reply.
#
# Usage:
#   agent-send.sh [--quiet] --agent <NAME> [--correlation-id <ID>]
#     [--result-token <TOKEN>] <TMUX_TARGET> <PROMPT> [TIMEOUT_SECONDS]
#
# --agent defaults to "codex". Prints the agent reply to stdout and streams
# readable pane progress to stderr unless --quiet is supplied.
# Exit codes: 0 success, 4 progress checkpoint, 5 no live agent TUI,
# 6 approval-pending (agent blocked on an interactive approval dialog that
# needs a human), 65 no textual output, 66 output was not correlated,
# 67 correlated output could not be parsed, 124 stalled checkpoint.
#
# Environment overrides:
#   AGENT_POLL_INTERVAL   seconds between polls (default: 2)
#   AGENT_IDLE_ROUNDS     consecutive stable polls before declaring done (default: 3)
#   AGENT_STALL_TIMEOUT   max seconds without pane changes before stalled (default: 300)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS_DIR="$SCRIPT_DIR/../agents"
# Dedicated tmux socket (see _mesh-tmux.sh).
# shellcheck source=/dev/null
source "$SCRIPT_DIR/_mesh-tmux.sh"

AGENT_NAME="codex"
QUIET="false"
CORRELATION_ID=""
RESULT_TOKEN=""
ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --agent) AGENT_NAME="$2"; shift 2 ;;
        --quiet) QUIET="true"; shift ;;
        --correlation-id) CORRELATION_ID="$2"; shift 2 ;;
        --result-token) RESULT_TOKEN="$2"; shift 2 ;;
        *)       ARGS+=("$1"); shift ;;
    esac
done
set -- "${ARGS[@]:-}"

CONF="$AGENTS_DIR/${AGENT_NAME}.conf"
[[ -f "$CONF" ]] || { echo "ERROR: no config for agent '$AGENT_NAME'" >&2; exit 1; }
# shellcheck source=/dev/null
source "$CONF"

TARGET="${1:-}"; PROMPT="${2:-}"; TIMEOUT="${3:-120}"
POLL="${AGENT_POLL_INTERVAL:-2}"
IDLE_NEEDED="${AGENT_IDLE_ROUNDS:-3}"
STALL="${AGENT_STALL_TIMEOUT:-300}"

[[ -z "$TARGET" ]] && { echo "ERROR: TMUX_TARGET required" >&2; exit 1; }
[[ -z "$PROMPT" ]] && { echo "ERROR: PROMPT required" >&2; exit 1; }
if [[ -n "$CORRELATION_ID" || -n "$RESULT_TOKEN" ]]; then
    [[ -n "$CORRELATION_ID" && "$CORRELATION_ID" =~ ^[A-Za-z0-9._:-]+$ ]] \
        || { echo "ERROR: invalid or missing correlation ID" >&2; exit 1; }
    [[ -n "$RESULT_TOKEN" && "$RESULT_TOKEN" =~ ^[a-f0-9]{16}$ ]] \
        || { echo "ERROR: invalid or missing result token" >&2; exit 1; }
    # The short first line is a stable terminal anchor even when the actual
    # prompt wraps. Keeping both result markers on that skipped line prevents
    # the collector from mistaking the protocol instruction for the response.
    PROTOCOL_ANCHOR="[MESH:${RESULT_TOKEN}]"
    RESULT_BEGIN="[[R:${RESULT_TOKEN}]]"
    RESULT_END="[[/R:${RESULT_TOKEN}]]"
    PROMPT="${PROTOCOL_ANCHOR} Put only your final task result between ${RESULT_BEGIN} and ${RESULT_END}."$'\n'"${PROMPT}"
fi
mtmux has-session -t "$TARGET" 2>/dev/null \
    || { echo "ERROR: tmux session '$TARGET' not found" >&2; exit 1; }

# A session created through the governed launcher owns one lease for its whole
# life. Sending another prompt uses that existing lease; it must never create a
# second route for a live target. The monitor renews and closes it separately.
SESSION_LEASE_STATE="${MESH_CAPACITY_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/agent-mesh/capacity-queue.json}"
if [[ -r "$SESSION_LEASE_STATE" ]]; then
    LEASE_SUMMARY="$(node -e '
const fs = require("fs");
try {
  const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const session = Array.isArray(state.sessions) && state.sessions.find(item => item.target === process.argv[2]);
  if (session?.candidate?.key && session?.candidate?.model && session?.candidate?.effort) {
    process.stdout.write(`${session.status}\t${session.candidate.model}\t${session.candidate.effort}`);
  }
} catch {}
' "$SESSION_LEASE_STATE" "$TARGET")"
    if [[ -n "$LEASE_SUMMARY" ]]; then
        IFS=$'\t' read -r LEASE_STATUS LEASE_MODEL LEASE_EFFORT <<<"$LEASE_SUMMARY"
        echo "Limen session lease: status=$LEASE_STATUS candidate=$LEASE_MODEL/$LEASE_EFFORT (no reroute)" >&2
    fi
fi
# New configs declare a precise alive pattern. Fall back to the existing agent
# lifecycle fields for portable third-party configs until they add one.
AGENT_ALIVE_PATTERN="${AGENT_ALIVE_PATTERN:-${AGENT_WORKING_PATTERN:-}|${AGENT_IDLE_PATTERN:-}|${AGENT_PROMPT_CHAR:-}}"
[[ "$AGENT_ALIVE_PATTERN" != "||" ]] \
    || { echo "ERROR: agent '$AGENT_NAME' has no live-TUI pattern" >&2; exit 1; }

_require_live_agent_tui() {
    local pane pane_command
    pane="$(mtmux capture-pane -t "$TARGET" -p 2>/dev/null || true)"
    pane_command="$(mtmux display-message -p -t "$TARGET" '#{pane_current_command}' 2>/dev/null || true)"
    if ! echo "$pane" | grep -qE "$AGENT_ALIVE_PATTERN"; then
        echo "ERROR: target '$TARGET' does not show a live $AGENT_NAME TUI; prompt was not pasted. Use agent-session.sh --agent $AGENT_NAME resume <SESSION_ID> or new <CWD>." >&2
        return 1
    fi
    if [[ -n "${AGENT_ALIVE_PROCESS_PATTERN:-}" ]] \
        && ! echo "$pane_command" | grep -qE "$AGENT_ALIVE_PROCESS_PATTERN"; then
        echo "ERROR: target '$TARGET' is running '$pane_command', not a live $AGENT_NAME TUI; prompt was not pasted. Use agent-session.sh --agent $AGENT_NAME resume <SESSION_ID> or new <CWD>." >&2
        return 1
    fi
}

# A tmux session may survive after its agent CLI dies and leave a bare shell in
# the pane. Never paste a prompt into that shell.
_require_live_agent_tui || exit 5

_approval_blocked_msg() {
    echo "APPROVAL-PENDING: target '$TARGET' is blocked on an interactive approval dialog; $1. Have the user attach to answer it: tmux -L $MESH_TMUX_SOCKET attach -t $TARGET" >&2
}

# A pending approval dialog captures the composer's input: pasted text is
# swallowed and the submit key would blind-confirm the dialog (possibly a
# destructive command). Refuse to send instead.
_pane_before="$(mtmux capture-pane -t "$TARGET" -p 2>/dev/null || true)"
if mesh_pane_approval_pending "$_pane_before"; then
    _approval_blocked_msg "prompt was not pasted"
    exit 6
fi

PROMPT_MATCH_HEAD="${PROTOCOL_ANCHOR:-${PROMPT%%$'\n'*}}"
[[ -n "$PROMPT_MATCH_HEAD" ]] || PROMPT_MATCH_HEAD="$PROMPT"

if [[ "${AGENT_SUPPORTS_LAUNCH_TITLE:-false}" == "true" ]]; then
    TITLE_FILE="$(mesh_pending_title_file "$TARGET")"
    if [[ -s "$TITLE_FILE" ]]; then
        LAUNCH_TITLE="$(cat "$TITLE_FILE")"
        rm -f "$TITLE_FILE"
        if [[ -n "$LAUNCH_TITLE" ]]; then
            PROMPT="${LAUNCH_TITLE}"$'\n\n'"${PROMPT}"
        fi
    fi
fi

# Clear any partial input, then load prompt via paste-buffer to safely handle
# special characters and multiline text (tmux send-keys would misinterpret them).
mtmux send-keys -t "$TARGET" "" 2>/dev/null || true
sleep 0.3
TMPFILE=$(mktemp)
BUFFER_NAME="_agent_send_$$"
trap 'rm -f "$TMPFILE"; mtmux delete-buffer -b "$BUFFER_NAME" 2>/dev/null || true' EXIT
printf '%s' "$PROMPT" > "$TMPFILE"
mtmux load-buffer -b "$BUFFER_NAME" "$TMPFILE"
rm -f "$TMPFILE"
mtmux paste-buffer -b "$BUFFER_NAME" -t "$TARGET"
mtmux delete-buffer -b "$BUFFER_NAME" 2>/dev/null || true
trap - EXIT
sleep 0.2

# A large paste lands in several bracketed-paste chunks, each rendered
# asynchronously as a collapsed "[Pasted Content N chars]" placeholder. Wait for
# the pane to stop mutating before submitting, otherwise the still-rendering
# paste looks like "the turn started".
_settle_prev=""
for _ in 1 2 3 4 5 6 7 8; do
    sleep 0.5
    _settle_now="$(mtmux capture-pane -t "$TARGET" -p 2>/dev/null)"
    [[ "$_settle_now" == "$_settle_prev" ]] && break
    _settle_prev="$_settle_now"
done

# Submit and CONFIRM the turn actually started. Confirmation keys on the working
# spinner ONLY — NOT "the pane changed" (the paste keeps repainting the pane as it
# renders) and NOT the done marker (the PREVIOUS turn's "Worked for …" lingers on
# screen and would falsely confirm after a single dropped submit key). A new turn
# always shows the working spinner, which a finished turn does not. Keep re-sending
# until it appears; submit keys hitting an already-empty composer are harmless.
submitted=0
stream_previous="${_settle_now:-}"
for _attempt in 1 2 3 4 5 6 7 8; do
    # The CLI can die after the paste. Check each retry so Enter never reaches
    # the bare shell that tmux leaves behind.
    _require_live_agent_tui || exit 5
    # An approval dialog can also appear between retries; the submit key would
    # confirm it. Re-check before every keypress.
    _now="$(mtmux capture-pane -t "$TARGET" -p 2>/dev/null)"
    if mesh_pane_approval_pending "$_now"; then
        _approval_blocked_msg "submit halted"
        exit 6
    fi
    mtmux send-keys -t "$TARGET" "$AGENT_SUBMIT_KEY"
    sleep 1
    _now="$(mtmux capture-pane -t "$TARGET" -p 2>/dev/null)"
    if echo "$_now" | grep -qE "$AGENT_WORKING_PATTERN"; then
        submitted=1
        stream_previous="$_now"
        break
    fi
done
[[ "$submitted" -eq 1 ]] || echo "WARN: submission may not have registered for '$TARGET'" >&2

deadline=$(( $(date +%s) + TIMEOUT ))
idle_rounds=0
last_output=""
last_activity="$(date +%s)"

while true; do
    now="$(date +%s)"
    if [[ "$now" -ge "$deadline" ]]; then
        inactive=$(( now - last_activity ))
        if [[ "$inactive" -le "$STALL" ]]; then
            echo "PROGRESS: no final reply in ${TIMEOUT}s, but pane changed ${inactive}s ago" >&2
            exit 4
        fi
        echo "STALLED: no final reply in ${TIMEOUT}s and no pane activity for ${inactive}s" >&2
        exit 124
    fi
    sleep "$POLL"
    output=$(mtmux capture-pane -t "$TARGET" -p 2>/dev/null)
    [[ "$QUIET" == "true" ]] \
        || mesh_stream_pane_delta "$output" "$stream_previous" 2
    stream_previous="$output"

    if mesh_pane_approval_pending "$output"; then
        _approval_blocked_msg "no final reply will arrive until it is answered"
        exit 6
    fi

    if echo "$output" | grep -qE "$AGENT_WORKING_PATTERN"; then
        [[ "$output" != "$last_output" ]] && last_activity="$(date +%s)"
        idle_rounds=0; last_output="$output"; continue
    fi

    if [[ "$output" == "$last_output" ]]; then
        idle_rounds=$(( idle_rounds + 1 ))
    else
        idle_rounds=0; last_output="$output"; last_activity="$(date +%s)"
    fi

    [[ $idle_rounds -ge $IDLE_NEEDED ]] && break
done

# Extract reply from tmux scrollback, not only the visible pane. Task-mode sends
# use a compact correlation anchor and explicit result markers. Legacy callers
# retain the original prompt-head extraction contract.
PROMPT_HEAD="$PROMPT_MATCH_HEAD"
FULL_OUTPUT="$(mtmux capture-pane -t "$TARGET" -p -S - 2>/dev/null || true)"
SEGMENT="$(echo "$FULL_OUTPUT" \
    | awk -v prompt="$PROMPT_HEAD" -v pc="$AGENT_PROMPT_CHAR" '
        $0 ~ pc && index($0, prompt) { found=1; next }
        found && $0 ~ pc { exit }
        found { print }
    ')"

if [[ -n "$RESULT_TOKEN" ]]; then
    if grep -Fq "$RESULT_BEGIN" <<<"$SEGMENT" && ! grep -Fq "$RESULT_END" <<<"$SEGMENT"; then
        echo "PARSING-FAILURE: correlated result begin marker has no matching end marker for '$CORRELATION_ID'" >&2
        exit 67
    fi
    if ! grep -Fq "$RESULT_BEGIN" <<<"$SEGMENT" && grep -Fq "$RESULT_END" <<<"$SEGMENT"; then
        echo "PARSING-FAILURE: correlated result end marker has no matching begin marker for '$CORRELATION_ID'" >&2
        exit 67
    fi
    if grep -Fq "$RESULT_BEGIN" <<<"$SEGMENT" && grep -Fq "$RESULT_END" <<<"$SEGMENT"; then
        RESULT="$(awk -v begin="$RESULT_BEGIN" -v end="$RESULT_END" '
            index($0, begin) { collecting=1; next }
            collecting && index($0, end) { exit }
            collecting { print }
        ' <<<"$SEGMENT" | sed '/^[[:space:]]*$/d')"
        [[ -n "${RESULT//[[:space:]]/}" ]] \
            || { echo "NO-OUTPUT: agent returned an empty correlated result for '$CORRELATION_ID'" >&2; exit 65; }
        printf '%s\n' "$RESULT"
        exit 0
    fi
    if [[ -n "${AGENT_RESPONSE_PATTERN:-}" ]] && ! grep -qE "$AGENT_RESPONSE_PATTERN" <<<"$SEGMENT"; then
        echo "NO-OUTPUT: agent completed without a textual response for '$CORRELATION_ID'" >&2
        exit 65
    fi
    echo "UNCORRELATED-OUTPUT: agent produced output without the expected result markers for '$CORRELATION_ID'" >&2
    exit 66
fi

echo "$SEGMENT" \
    | sed 's/^[[:space:]]*//' \
    | grep -v '^[[:space:]]*$' \
    || true
