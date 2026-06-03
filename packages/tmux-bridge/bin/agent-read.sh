#!/bin/bash
# agent-read.sh — Capture output from an AI agent CLI running in tmux.
#
# Usage:
#   agent-read.sh --agent <NAME> <TMUX_TARGET> [--full | --last-reply | --status]
#
# --agent defaults to "codex".
# Modes:
#   --full        Raw tmux pane dump (default)
#   --last-reply  Most recent agent reply block
#   --status      Print: idle | working | error

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS_DIR="$SCRIPT_DIR/../agents"

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

TARGET="${1:-}"; MODE="${2:---full}"
[[ -z "$TARGET" ]] && { echo "ERROR: TMUX_TARGET required" >&2; exit 1; }
tmux has-session -t "$TARGET" 2>/dev/null \
    || { echo "ERROR: tmux session '$TARGET' not found" >&2; exit 1; }

output=$(tmux capture-pane -t "$TARGET" -p 2>/dev/null)

case "$MODE" in
    --full)
        echo "$output"
        ;;
    --status)
        if   echo "$output" | grep -qE "$AGENT_WORKING_PATTERN"; then echo "working"
        elif echo "$output" | grep -qiE "error|failed|exception";  then echo "error"
        else echo "idle"
        fi
        ;;
    --last-reply)
        echo "$output" \
            | awk -v pc="$AGENT_PROMPT_CHAR" '
                $0 ~ pc { in_reply=0 }
                in_reply { print }
                /[•◦●✻]/ { in_reply=1 }
            ' \
            | sed 's/^[[:space:]]*//' \
            | grep -v '^[[:space:]]*$' \
            || true
        ;;
    *)
        echo "ERROR: unknown mode '$MODE'" >&2; exit 1
        ;;
esac
