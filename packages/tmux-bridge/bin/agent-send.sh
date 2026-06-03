#!/bin/bash
# agent-send.sh — Send a prompt to an AI agent CLI running in tmux, wait for reply.
#
# Usage:
#   agent-send.sh --agent <NAME> <TMUX_TARGET> <PROMPT> [TIMEOUT_SECONDS]
#
# --agent defaults to "codex". Prints the agent reply to stdout.
# Exit codes: 0 success, 2 timeout.
#
# Environment overrides:
#   AGENT_POLL_INTERVAL   seconds between polls (default: 2)
#   AGENT_IDLE_ROUNDS     consecutive stable polls before declaring done (default: 3)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS_DIR="$SCRIPT_DIR/../agents"
# Dedicated tmux socket (see _mesh-tmux.sh).
# shellcheck source=/dev/null
source "$SCRIPT_DIR/_mesh-tmux.sh"

AGENT_NAME="codex"
ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --agent) AGENT_NAME="$2"; shift 2 ;;
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

[[ -z "$TARGET" ]] && { echo "ERROR: TMUX_TARGET required" >&2; exit 1; }
[[ -z "$PROMPT" ]] && { echo "ERROR: PROMPT required" >&2; exit 1; }
mtmux has-session -t "$TARGET" 2>/dev/null \
    || { echo "ERROR: tmux session '$TARGET' not found" >&2; exit 1; }

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
mtmux send-keys -t "$TARGET" "$AGENT_SUBMIT_KEY"

deadline=$(( $(date +%s) + TIMEOUT ))
idle_rounds=0
last_output=""

while true; do
    [[ $(date +%s) -ge $deadline ]] && { echo "TIMEOUT: no reply in ${TIMEOUT}s" >&2; exit 2; }
    sleep "$POLL"
    output=$(mtmux capture-pane -t "$TARGET" -p 2>/dev/null)

    if echo "$output" | grep -qE "$AGENT_WORKING_PATTERN"; then
        idle_rounds=0; last_output="$output"; continue
    fi

    if [[ "$output" == "$last_output" ]]; then
        idle_rounds=$(( idle_rounds + 1 ))
    else
        idle_rounds=0; last_output="$output"
    fi

    [[ $idle_rounds -ge $IDLE_NEEDED ]] && break
done

# Extract reply: lines between the echoed prompt and the next prompt character.
# Multiline prompts are echoed over multiple pane lines, so anchor on the first
# submitted line instead of requiring the whole prompt to appear on one line.
PROMPT_HEAD="${PROMPT%%$'\n'*}"
[[ -n "$PROMPT_HEAD" ]] || PROMPT_HEAD="$PROMPT"
echo "$last_output" \
    | awk -v prompt="$PROMPT_HEAD" -v pc="$AGENT_PROMPT_CHAR" '
        $0 ~ pc && index($0, prompt) { found=1; next }
        found && $0 ~ pc { exit }
        found { print }
    ' \
    | sed 's/^[[:space:]]*//' \
    | grep -v '^[[:space:]]*$' \
    || true
