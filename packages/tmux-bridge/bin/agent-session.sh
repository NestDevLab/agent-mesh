#!/bin/bash
# agent-session.sh — Create or resume an AI agent CLI session inside tmux.
#
# Usage:
#   agent-session.sh --agent <NAME> [--model <name>] [--effort <level>] resume <SESSION_ID> [TMUX_NAME] [-- <extra agent args>]
#   agent-session.sh --agent <NAME> [--model <name>] [--effort <level>] new    [CWD]        [TMUX_NAME] [-- <extra agent args>]
#   agent-session.sh --agent codex --title <TITLE> new [CWD] [TMUX_NAME] [-- <extra agent args>]
#   agent-session.sh --agent <NAME> list
#   agent-session.sh --agent <NAME> kill   <TMUX_NAME>
#
# --agent defaults to "codex". Config files: ../agents/<name>.conf
# Prints the tmux target name on stdout so callers can pipe into agent-send.sh.
#
# Everything after `--` is passed verbatim as extra flags to the agent CLI and
# takes precedence over the first-class model/effort flags. Example (xhigh +
# Codex Desktop visibility + correct cwd, all via the bridge):
#   agent-session.sh --agent codex new "$PWD" mesh-codex-b1 -- -c model_reasoning_effort=xhigh
#
# Codex launch titles:
#   agent-session.sh --agent codex --title "agent-mesh: review API" new "$PWD" mesh-codex-api
# The bridge prepends the title as the first line of the first prompt sent with
# agent-send.sh. Codex Desktop derives the thread title from that first message,
# so this avoids DB edits/restarts without creating a separate synthetic turn.
#
# Environment overrides:
#   AGENT_MESH_ROOT    repo root (auto-derived from script location if unset)
#   TMUX_SESSION_PREFIX  tmux name prefix (default: "mesh")

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_MESH_ROOT="${AGENT_MESH_ROOT:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"
AGENTS_DIR="$SCRIPT_DIR/../agents"
TMUX_SESSION_PREFIX="${TMUX_SESSION_PREFIX:-mesh}"

# Dedicated tmux socket + exit-empty off (see _mesh-tmux.sh).
# shellcheck source=/dev/null
source "$SCRIPT_DIR/_mesh-tmux.sh"

# ── parse --agent flag ────────────────────────────────────────────────────────
AGENT_NAME="codex"
SESSION_TITLE=""
SESSION_MODEL=""
SESSION_EFFORT=""
ARGS=()
PASSTHRU=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --agent) AGENT_NAME="$2"; shift 2 ;;
        --title)
            [[ $# -ge 2 && -n "${2:-}" ]] \
                || { echo "ERROR: --title requires a non-empty value" >&2; exit 1; }
            SESSION_TITLE="$2"
            shift 2
            ;;
        --model)
            [[ $# -ge 2 && -n "${2:-}" ]] \
                || { echo "ERROR: --model requires a non-empty value" >&2; exit 1; }
            SESSION_MODEL="$2"
            shift 2
            ;;
        --effort)
            [[ $# -ge 2 && -n "${2:-}" ]] \
                || { echo "ERROR: --effort requires a non-empty value" >&2; exit 1; }
            SESSION_EFFORT="$2"
            shift 2
            ;;
        --)      shift; PASSTHRU=("$@"); break ;;
        *)       ARGS+=("$1"); shift ;;
    esac
done
set -- "${ARGS[@]:-}"

CONF="$AGENTS_DIR/${AGENT_NAME}.conf"
[[ -f "$CONF" ]] || { echo "ERROR: no config for agent '$AGENT_NAME' ($CONF)" >&2; exit 1; }
# shellcheck source=/dev/null
source "$CONF"

if [[ -n "$SESSION_TITLE" ]]; then
    [[ "${AGENT_SUPPORTS_LAUNCH_TITLE:-false}" == "true" ]] \
        || { echo "ERROR: --title is not supported by agent '$AGENT_NAME'" >&2; exit 1; }
    [[ "$SESSION_TITLE" != *$'\n'* && "$SESSION_TITLE" != *$'\r'* ]] \
        || { echo "ERROR: --title must be a single line" >&2; exit 1; }
fi

# Extra agent flags (everything after `--`), shell-quoted so the inner shell that
# `tmux send-keys` feeds receives each argument intact (spaces, quotes, =).
# This must remain after the configured options: raw passthrough is the strongest
# launch setting by contract.
EXTRA_CMD=""
if [[ ${#PASSTHRU[@]} -gt 0 ]]; then
    for _a in "${PASSTHRU[@]}"; do
        EXTRA_CMD+=" $(printf '%q' "$_a")"
    done
fi

# ── launch-option mapping ────────────────────────────────────────────────────
# Configs declare support and an argument template array for each first-class
# knob. Keeping the mapping in the config makes model/effort selection agent-
# agnostic while preserving each CLI's native flag shape.
LAUNCH_OPTION_CMD=""
_append_agent_option() {
    local knob="$1" value="$2" supported templates=() template has_value="false"

    case "$knob" in
        model)
            supported="${AGENT_SUPPORTS_MODEL:-false}"
            templates=("${AGENT_MODEL_ARGS[@]}")
            ;;
        effort)
            supported="${AGENT_SUPPORTS_EFFORT:-false}"
            templates=("${AGENT_EFFORT_ARGS[@]}")
            ;;
        *)
            echo "ERROR: unknown launch option '$knob'" >&2
            exit 1
            ;;
    esac

    if [[ "$supported" != "true" ]]; then
        echo "ERROR: --$knob is not supported by agent '$AGENT_NAME'" >&2
        exit 1
    fi
    if [[ ${#templates[@]} -eq 0 ]]; then
        echo "ERROR: agent '$AGENT_NAME' has no --$knob argument mapping" >&2
        exit 1
    fi

    for template in "${templates[@]}"; do
        [[ "$template" == *"{VALUE}"* ]] && has_value="true"
        LAUNCH_OPTION_CMD+=" $(printf '%q' "${template//\{VALUE\}/$value}")"
    done
    [[ "$has_value" == "true" ]] \
        || { echo "ERROR: invalid --$knob mapping for agent '$AGENT_NAME'" >&2; exit 1; }
}

_build_launch_options() {
    local pin_env pin_value model_env effort_env model_value effort_value

    # Pinned defaults and their environment replacements are a single policy.
    # CODEX_MESH_PIN=0 (declared by codex.conf) suppresses both so workers follow
    # the desktop config; explicit --model/--effort still apply afterwards.
    pin_env="${AGENT_PIN_ENABLE_ENV:-}"
    pin_value=""
    [[ -n "$pin_env" ]] && pin_value="${!pin_env-}"
    if [[ -n "$pin_env" && "$pin_value" != "0" ]]; then
        [[ -n "${AGENT_PIN_DEFAULT_MODEL:-}" ]] \
            && _append_agent_option model "$AGENT_PIN_DEFAULT_MODEL"
        [[ -n "${AGENT_PIN_DEFAULT_EFFORT:-}" ]] \
            && _append_agent_option effort "$AGENT_PIN_DEFAULT_EFFORT"

        model_env="${AGENT_PIN_MODEL_ENV:-}"
        effort_env="${AGENT_PIN_EFFORT_ENV:-}"
        model_value=""
        effort_value=""
        [[ -n "$model_env" ]] && model_value="${!model_env-}"
        [[ -n "$effort_env" ]] && effort_value="${!effort_env-}"
        [[ -n "$model_env" && -n "$model_value" ]] \
            && _append_agent_option model "$model_value"
        [[ -n "$effort_env" && -n "$effort_value" ]] \
            && _append_agent_option effort "$effort_value"
    fi

    [[ -n "$SESSION_MODEL" ]] && _append_agent_option model "$SESSION_MODEL"
    [[ -n "$SESSION_EFFORT" ]] && _append_agent_option effort "$SESSION_EFFORT"
    return 0
}

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
        out=$(mtmux capture-pane -t "$target" -p 2>/dev/null)
        # Auto-confirm cwd picker if the agent shows one
        if [[ "$AGENT_HAS_CWD_PICKER" == "true" ]] && echo "$out" | grep -q "$AGENT_PICKER_PATTERN"; then
            mtmux send-keys -t "$target" "" Enter
            continue
        fi
        # Trust dialog (Claude Code) — confirm with Enter
        if echo "$out" | grep -q "Is this a project you trust"; then
            mtmux send-keys -t "$target" "" Enter
            continue
        fi
        # Idle prompt visible → ready
        if echo "$out" | grep -qE "$AGENT_IDLE_PATTERN|${AGENT_PROMPT_CHAR}"; then
            return 0
        fi
    done
    return 1
}

_print_attach_hint() {
    echo "ATTACH: tmux -L mesh attach -t $TARGET" >&2
}

# ── commands ──────────────────────────────────────────────────────────────────
cmd="${1:-}"; shift || true

if [[ -n "$SESSION_TITLE" && "$cmd" != "new" ]]; then
    echo "ERROR: --title is only supported with 'new'" >&2
    exit 1
fi
if [[ ( -n "$SESSION_MODEL" || -n "$SESSION_EFFORT" ) \
    && "$cmd" != "new" && "$cmd" != "resume" ]]; then
    echo "ERROR: --model and --effort are only supported with 'new' or 'resume'" >&2
    exit 1
fi
if [[ "$cmd" == "new" || "$cmd" == "resume" ]]; then
    _build_launch_options
fi

case "$cmd" in
    resume)
        SESSION_ID="${1:-}"
        TMUX_NAME="${2:-}"
        [[ -z "$SESSION_ID" ]] && { echo "ERROR: SESSION_ID required" >&2; exit 1; }
        TARGET=$(_tmux_target "${TMUX_NAME:-${TMUX_SESSION_PREFIX}-${AGENT_NAME}-${SESSION_ID:0:8}}")

        if mtmux has-session -t "$TARGET" 2>/dev/null; then
            _print_attach_hint
            echo "$TARGET"; exit 0
        fi

        if [[ "${AGENT_REQUIRE_FREE_SESSION_WRITER:-false}" == "true" ]]; then
            node "$SCRIPT_DIR/session-writer-status.mjs" \
                --agent "$AGENT_NAME" --session "$SESSION_ID" --require-free
        fi

        RESUME_CMD="${AGENT_RESUME_CMD//\{SESSION_ID\}/$SESSION_ID}$LAUNCH_OPTION_CMD$EXTRA_CMD"
        mtmux new-session -d -s "$TARGET"
        mesh_tmux_harden
        mtmux send-keys -t "$TARGET" "$RESUME_CMD" Enter
        _wait_for_ready "$TARGET" 30 \
            || echo "WARN: session '$TARGET' may not be fully ready yet" >&2
        _print_attach_hint
        echo "$TARGET"
        ;;

    new)
        CWD="${1:-$PWD}"
        # Resolve to an absolute path so both `tmux -c` and any agent --cd flag agree.
        CWD="$(cd "$CWD" 2>/dev/null && pwd || echo "$CWD")"
        TMUX_NAME="${2:-}"
        TARGET=$(_tmux_target "$TMUX_NAME")

        if mtmux has-session -t "$TARGET" 2>/dev/null; then
            if [[ -n "$SESSION_TITLE" ]]; then
                echo "WARN: session '$TARGET' already exists; --title was not updated" >&2
            fi
            echo "$TARGET"; exit 0
        fi

        mtmux new-session -d -s "$TARGET" -c "$CWD"
        mesh_tmux_harden
        # {CWD} placeholder lets an agent conf pin the working root (e.g. codex --cd).
        # Required in remote mode, where the agent's app-server ignores `tmux -c` and
        # would otherwise land in the server's own cwd. No-op for confs without {CWD}.
        NEW_CMD="${AGENT_NEW_CMD//\{CWD\}/$CWD}$LAUNCH_OPTION_CMD$EXTRA_CMD"
        mtmux send-keys -t "$TARGET" "$NEW_CMD" Enter
        _wait_for_ready "$TARGET" 30 \
            || echo "WARN: session '$TARGET' may not be fully ready yet" >&2
        if [[ -n "$SESSION_TITLE" ]]; then
            title_file="$(mesh_pending_title_file "$TARGET")"
            ( umask 077; printf '%s' "$SESSION_TITLE" > "$title_file" )
        fi
        _print_attach_hint
        echo "$TARGET"
        ;;

    list)
        echo "=== Running tmux sessions (${AGENT_NAME}) ==="
        mtmux list-sessions 2>/dev/null \
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
        rm -f "$(mesh_pending_title_file "$TARGET")"
        mtmux kill-session -t "$TARGET" && echo "Killed $TARGET"
        ;;

    *)
        sed -n '/^#/p' "$0" | sed 's/^# \{0,1\}//'
        exit 1
        ;;
esac
