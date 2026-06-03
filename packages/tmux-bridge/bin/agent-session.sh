#!/bin/bash
# agent-session.sh — Create or resume an AI agent CLI session inside tmux.
#
# Usage:
#   agent-session.sh --agent <NAME> resume <SESSION_ID> [TMUX_NAME]
#   agent-session.sh --agent <NAME> new    [CWD]        [TMUX_NAME]
#   agent-session.sh --agent <NAME> list
#   agent-session.sh --agent <NAME> kill   <TMUX_NAME>
#
# --agent defaults to "codex". Config files: ../agents/<name>.conf
# Prints the tmux target name on stdout so callers can pipe into agent-send.sh.
#
# Environment overrides:
#   AGENT_MESH_ROOT    repo root (auto-derived from script location if unset)
#   TMUX_SESSION_PREFIX  tmux name prefix (default: "mesh")

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_MESH_ROOT="${AGENT_MESH_ROOT:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"
AGENTS_DIR="$SCRIPT_DIR/../agents"
TMUX_SESSION_PREFIX="${TMUX_SESSION_PREFIX:-mesh}"

# ── parse --agent flag ────────────────────────────────────────────────────────
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
[[ -f "$CONF" ]] || { echo "ERROR: no config for agent '$AGENT_NAME' ($CONF)" >&2; exit 1; }
# shellcheck source=/dev/null
source "$CONF"

# ── helpers ───────────────────────────────────────────────────────────────────
_tmux_target() {
    local name="${1:-}"
    if [[ -z "$name" ]]; then
        echo "${TMUX_SESSION_PREFIX}-${AGENT_NAME}-$$"
    else
        echo "$name" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/-$//'
    fi
}

_wait_for_ready() {
    local target="$1" max_wait="${2:-30}" elapsed=0 out
    while [[ $elapsed -lt $max_wait ]]; do
        sleep 1; elapsed=$(( elapsed + 1 ))
        out=$(tmux capture-pane -t "$target" -p 2>/dev/null)
        # Auto-confirm cwd picker if the agent shows one
        if [[ "$AGENT_HAS_CWD_PICKER" == "true" ]] && echo "$out" | grep -q "$AGENT_PICKER_PATTERN"; then
            tmux send-keys -t "$target" "" Enter
            continue
        fi
        # Trust dialog (Claude Code) — confirm with Enter
        if echo "$out" | grep -q "Is this a project you trust"; then
            tmux send-keys -t "$target" "" Enter
            continue
        fi
        # Idle prompt visible → ready
        if echo "$out" | grep -qE "$AGENT_IDLE_PATTERN|${AGENT_PROMPT_CHAR}"; then
            return 0
        fi
    done
    return 1
}

# ── commands ──────────────────────────────────────────────────────────────────
cmd="${1:-}"; shift || true

case "$cmd" in
    resume)
        SESSION_ID="${1:-}"
        TMUX_NAME="${2:-}"
        [[ -z "$SESSION_ID" ]] && { echo "ERROR: SESSION_ID required" >&2; exit 1; }
        TARGET=$(_tmux_target "${TMUX_NAME:-${TMUX_SESSION_PREFIX}-${AGENT_NAME}-${SESSION_ID:0:8}}")

        if tmux has-session -t "$TARGET" 2>/dev/null; then
            echo "$TARGET"; exit 0
        fi

        RESUME_CMD="${AGENT_RESUME_CMD//\{SESSION_ID\}/$SESSION_ID}"
        tmux new-session -d -s "$TARGET"
        tmux send-keys -t "$TARGET" "$RESUME_CMD" Enter
        _wait_for_ready "$TARGET" 30 \
            || echo "WARN: session '$TARGET' may not be fully ready yet" >&2
        echo "$TARGET"
        ;;

    new)
        CWD="${1:-$PWD}"
        TMUX_NAME="${2:-}"
        TARGET=$(_tmux_target "$TMUX_NAME")

        if tmux has-session -t "$TARGET" 2>/dev/null; then
            echo "$TARGET"; exit 0
        fi

        tmux new-session -d -s "$TARGET" -c "$CWD"
        tmux send-keys -t "$TARGET" "$AGENT_NEW_CMD" Enter
        _wait_for_ready "$TARGET" 30 \
            || echo "WARN: session '$TARGET' may not be fully ready yet" >&2
        echo "$TARGET"
        ;;

    list)
        echo "=== Running tmux sessions (${AGENT_NAME}) ==="
        tmux list-sessions 2>/dev/null \
            | grep "^${TMUX_SESSION_PREFIX}-${AGENT_NAME}" || echo "(none)"
        echo ""
        echo "=== On-disk sessions — last 10 (${AGENT_NAME}) ==="
        find "$AGENT_SESSION_DIR" -name "*.jsonl" 2>/dev/null \
            | sort -r | head -10 \
            | while read -r f; do
                id=$(basename "$f" \
                    | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' \
                    | head -1)
                cwd=$(eval "$AGENT_SESSION_CWD_EXTRACTOR \"$f\"" 2>/dev/null || echo "?")
                ts=$(stat -c '%y' "$f" 2>/dev/null | cut -d' ' -f1 || echo "?")
                printf "  %s  %s  %s\n" "$id" "$ts" "$cwd"
            done
        ;;

    kill)
        TARGET="${1:-}"
        [[ -z "$TARGET" ]] && { echo "ERROR: TMUX_NAME required" >&2; exit 1; }
        tmux kill-session -t "$TARGET" && echo "Killed $TARGET"
        ;;

    *)
        sed -n '/^#/p' "$0" | sed 's/^# \{0,1\}//'
        exit 1
        ;;
esac
