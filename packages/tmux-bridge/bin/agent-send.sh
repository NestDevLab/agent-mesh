#!/bin/bash
# agent-send.sh — Send a prompt to an AI agent CLI running in tmux, wait for reply.
#
# Usage:
#   agent-send.sh [--quiet] --agent <NAME> <TMUX_TARGET> <PROMPT> [TIMEOUT_SECONDS]
#
# --agent defaults to "codex". Prints the agent reply to stdout and streams
# readable pane progress to stderr unless --quiet is supplied.
# Exit codes: 0 success, 4 progress checkpoint, 124 stalled checkpoint.
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
ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --agent) AGENT_NAME="$2"; shift 2 ;;
        --quiet) QUIET="true"; shift ;;
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
mtmux has-session -t "$TARGET" 2>/dev/null \
    || { echo "ERROR: tmux session '$TARGET' not found" >&2; exit 1; }

PROMPT_MATCH_HEAD="${PROMPT%%$'\n'*}"
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

# Extract reply: lines between the echoed prompt and the next prompt character.
# Multiline prompts are echoed over multiple pane lines, so anchor on the first
# real submitted line instead of the launch-title prefix or whole prompt.
PROMPT_HEAD="$PROMPT_MATCH_HEAD"
echo "$last_output" \
    | awk -v prompt="$PROMPT_HEAD" -v pc="$AGENT_PROMPT_CHAR" '
        $0 ~ pc && index($0, prompt) { found=1; next }
        found && $0 ~ pc { exit }
        found { print }
    ' \
    | sed 's/^[[:space:]]*//' \
    | grep -v '^[[:space:]]*$' \
    || true
