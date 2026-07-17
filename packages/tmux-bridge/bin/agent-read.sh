#!/bin/bash
# agent-read.sh — Capture output from an AI agent CLI running in tmux.
#
# Usage:
#   agent-read.sh --agent <NAME> <TMUX_TARGET> [--full | --last-reply | --status]
#   agent-read.sh --agent <NAME> <TMUX_TARGET> --follow [--forever]
#
# --agent defaults to "codex".
# Modes:
#   --full        Raw tmux pane dump (default)
#   --last-reply  Most recent agent reply block
#   --status      Print: idle | working | error
#   --follow      Stream new pane lines until a working turn returns to idle
#   --forever     With --follow, keep watching across turns
#   --poll SEC    Follow poll interval (default: 3)
#   --max-wait SEC Follow guard rail (default: 3600)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS_DIR="$SCRIPT_DIR/../agents"
# Dedicated tmux socket (see _mesh-tmux.sh).
# shellcheck source=/dev/null
source "$SCRIPT_DIR/_mesh-tmux.sh"

AGENT_NAME="codex"
FOLLOW="false"
FOREVER="false"
POLL="3"
MAX_WAIT="3600"
ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --agent) AGENT_NAME="$2"; shift 2 ;;
        --follow) FOLLOW="true"; shift ;;
        --forever) FOREVER="true"; shift ;;
        --poll) POLL="$2"; shift 2 ;;
        --max-wait) MAX_WAIT="$2"; shift 2 ;;
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
mtmux has-session -t "$TARGET" 2>/dev/null \
    || { echo "ERROR: tmux session '$TARGET' not found" >&2; exit 1; }

if [[ "$FOLLOW" == "true" ]]; then
    [[ "$MODE" == "--full" ]] || {
        echo "ERROR: --follow cannot be combined with $MODE" >&2
        exit 1
    }
    [[ "$POLL" =~ ^[0-9]+([.][0-9]+)?$ && "$POLL" != "0" ]] \
        || { echo "ERROR: --poll must be a positive number" >&2; exit 1; }
    [[ "$MAX_WAIT" =~ ^[0-9]+$ && "$MAX_WAIT" != "0" ]] \
        || { echo "ERROR: --max-wait must be a positive integer" >&2; exit 1; }

    stream_previous="$(mtmux capture-pane -t "$TARGET" -p 2>/dev/null)" \
        || { echo "ERROR: tmux target '$TARGET' disappeared" >&2; exit 3; }
    start_time="$(date +%s)"
    seen_working="false"
    idle_rounds=0

    if echo "$stream_previous" | grep -qE "$AGENT_WORKING_PATTERN"; then
        seen_working="true"
    fi

    stream_pane_delta() {
        local current="$1" previous="$2" line
        [[ "$current" == "$previous" ]] && return 0
        while IFS= read -r line; do
            [[ -z "$line" ]] && continue
            if [[ -n "$AGENT_WORKING_PATTERN" ]] \
               && grep -Eq "$AGENT_WORKING_PATTERN" <<<"$line"; then
                continue
            fi
            if [[ -n "$previous" ]] && grep -Fqx -- "$line" <<<"$previous"; then
                continue
            fi
            printf '%s\n' "$line"
        done <<< "$current"
    }

    while true; do
        now="$(date +%s)"
        if (( now - start_time >= MAX_WAIT )); then
            echo "ERROR: follow exceeded max wait of ${MAX_WAIT}s" >&2
            exit 124
        fi
        sleep "$POLL"
        mtmux has-session -t "$TARGET" 2>/dev/null \
            || { echo "ERROR: tmux target '$TARGET' disappeared" >&2; exit 3; }
        output="$(mtmux capture-pane -t "$TARGET" -p 2>/dev/null)" \
            || { echo "ERROR: tmux target '$TARGET' disappeared" >&2; exit 3; }
        stream_pane_delta "$output" "$stream_previous"

        if echo "$output" | grep -qE "$AGENT_WORKING_PATTERN"; then
            seen_working="true"
            idle_rounds=0
        elif [[ "$seen_working" == "true" ]]; then
            if [[ "$output" == "$stream_previous" ]]; then
                idle_rounds=$(( idle_rounds + 1 ))
            else
                idle_rounds=0
            fi
            if [[ "$FOREVER" != "true" && "$idle_rounds" -ge "${AGENT_IDLE_ROUNDS:-3}" ]]; then
                exit 0
            fi
        fi
        stream_previous="$output"
    done
fi

output=$(mtmux capture-pane -t "$TARGET" -p 2>/dev/null)

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
