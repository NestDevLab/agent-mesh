#!/bin/bash
# agent-session.sh — Create or resume an AI agent CLI session inside tmux.
#
# Usage:
#   agent-session.sh --agent <NAME> [--model <name>] [--effort <level>] [--approval-policy <policy>] resume <SESSION_ID> [TMUX_NAME] [-- <extra agent args>]
#   agent-session.sh --agent <NAME> [--model <name>] [--effort <level>] [--approval-policy <policy>] new    [CWD]        [TMUX_NAME] [-- <extra agent args>]
#   agent-session.sh --agent codex --title <TITLE> new [CWD] [TMUX_NAME] [-- <extra agent args>]
#   agent-session.sh --agent <NAME> list [--json] [--limit <COUNT>]
#   agent-session.sh --agent <NAME> inspect <SESSION_ID> [--json]
#   agent-session.sh --agent <NAME> writer-status <SESSION_ID> [--json]
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
SESSION_APPROVAL_POLICY=""
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
        --approval-policy)
            [[ $# -ge 2 && -n "${2:-}" ]] \
                || { echo "ERROR: --approval-policy requires a non-empty value" >&2; exit 1; }
            SESSION_APPROVAL_POLICY="$2"
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

_passthru_overrides_knob() {
    local knob="$1" arg pattern patterns=()

    case "$knob" in
        model)
            if declare -p AGENT_MODEL_PASSTHRU_PATTERNS >/dev/null 2>&1; then
                patterns=("${AGENT_MODEL_PASSTHRU_PATTERNS[@]}")
            fi
            ;;
        effort)
            if declare -p AGENT_EFFORT_PASSTHRU_PATTERNS >/dev/null 2>&1; then
                patterns=("${AGENT_EFFORT_PASSTHRU_PATTERNS[@]}")
            fi
            ;;
        *) return 1 ;;
    esac

    for arg in "${PASSTHRU[@]}"; do
        for pattern in "${patterns[@]}"; do
            [[ "$arg" == $pattern ]] && return 0
        done
    done
    return 1
}

# ── launch-option mapping ────────────────────────────────────────────────────
# Configs declare support and an argument template array for each first-class
# knob. Keeping the mapping in the config makes model/effort selection agent-
# agnostic while preserving each CLI's native flag shape.
LAUNCH_OPTION_CMD=""
_append_agent_option() {
    local knob="$1" value="$2" supported templates=() template has_value="false" allowed=""

    case "$knob" in
        model)
            supported="${AGENT_SUPPORTS_MODEL:-false}"
            templates=("${AGENT_MODEL_ARGS[@]}")
            ;;
        effort)
            supported="${AGENT_SUPPORTS_EFFORT:-false}"
            templates=("${AGENT_EFFORT_ARGS[@]}")
            ;;
        approval-policy)
            supported="${AGENT_SUPPORTS_APPROVAL_POLICY:-false}"
            templates=("${AGENT_APPROVAL_POLICY_ARGS[@]}")
            allowed="${AGENT_APPROVAL_POLICY_VALUES:-}"
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
    # Configs may enumerate accepted values for knobs whose CLI rejects unknown
    # ones at launch — catching it here beats spawning a session that dies.
    if [[ -n "$allowed" && " $allowed " != *" $value "* ]]; then
        echo "ERROR: invalid --$knob '$value' for agent '$AGENT_NAME' (accepted: $allowed)" >&2
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
    model_value=""
    effort_value=""
    [[ -n "$pin_env" ]] && pin_value="${!pin_env-}"
    if [[ -n "$pin_env" && "$pin_value" != "0" ]]; then
        model_value="${AGENT_PIN_DEFAULT_MODEL:-}"
        effort_value="${AGENT_PIN_DEFAULT_EFFORT:-}"

        model_env="${AGENT_PIN_MODEL_ENV:-}"
        effort_env="${AGENT_PIN_EFFORT_ENV:-}"
        [[ -n "$model_env" && -n "${!model_env-}" ]] && model_value="${!model_env}"
        [[ -n "$effort_env" && -n "${!effort_env-}" ]] && effort_value="${!effort_env}"
    fi

    [[ -n "$SESSION_MODEL" ]] && model_value="$SESSION_MODEL"
    [[ -n "$SESSION_EFFORT" ]] && effort_value="$SESSION_EFFORT"
    if [[ -n "$model_value" ]] && ! _passthru_overrides_knob model; then
        _append_agent_option model "$model_value"
    fi
    if [[ -n "$effort_value" ]] && ! _passthru_overrides_knob effort; then
        _append_agent_option effort "$effort_value"
    fi
    [[ -n "$SESSION_APPROVAL_POLICY" ]] \
        && _append_agent_option approval-policy "$SESSION_APPROVAL_POLICY"
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

_print_launch_warning() {
    [[ -z "${AGENT_LAUNCH_WARNING:-}" ]] || echo "WARN: $AGENT_LAUNCH_WARNING" >&2
}

_session_file() {
    local session_id="$1"
    [[ -d "$AGENT_SESSION_DIR" ]] || return 0
    find "$AGENT_SESSION_DIR" -type f -name "*${session_id}*.jsonl" -print -quit 2>/dev/null || true
}

_session_row() {
    local file="$1" id cwd updated_epoch
    id=$(basename "$file" \
        | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' \
        | sed -n '1p' || true)
    [[ -n "$id" ]] || return 0
    cwd=$(eval "$AGENT_SESSION_CWD_EXTRACTOR \"$file\"" 2>/dev/null || echo "?")
    updated_epoch=$(stat -c '%Y' "$file" 2>/dev/null || echo 0)
    printf '%s\t%s\t%s\n' "$id" "$updated_epoch" "$cwd"
}

_session_rows() {
    local limit="$1"
    [[ -d "$AGENT_SESSION_DIR" ]] || return 0
    find "$AGENT_SESSION_DIR" -type f -name '*.jsonl' -printf '%T@\t%p\n' 2>/dev/null \
        | sort -t $'\t' -k1,1nr \
        | sed -n "1,${limit}p" \
        | cut -f2- \
        | while IFS= read -r file; do
            [[ -n "$file" ]] && _session_row "$file"
        done
}

_session_rows_json() {
    python3 -c '
import datetime
import json
import sys

agent_type = sys.argv[1]
sessions = []
for line in sys.stdin:
    session_id, updated_epoch, cwd = line.rstrip("\n").split("\t", 2)
    timestamp = datetime.datetime.fromtimestamp(int(updated_epoch), datetime.timezone.utc)
    sessions.append({
        "session_id": session_id,
        "agent_type": agent_type,
        "cwd": cwd,
        "updated_at": timestamp.isoformat().replace("+00:00", "Z"),
    })
print(json.dumps({"agent_type": agent_type, "sessions": sessions}))
' "$AGENT_NAME"
}

# ── commands ──────────────────────────────────────────────────────────────────
cmd="${1:-}"; shift || true

if [[ -n "$SESSION_TITLE" && "$cmd" != "new" ]]; then
    echo "ERROR: --title is only supported with 'new'" >&2
    exit 1
fi
if [[ ( -n "$SESSION_MODEL" || -n "$SESSION_EFFORT" || -n "$SESSION_APPROVAL_POLICY" ) \
    && "$cmd" != "new" && "$cmd" != "resume" ]]; then
    echo "ERROR: --model, --effort, and --approval-policy are only supported with 'new' or 'resume'" >&2
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

        _print_launch_warning
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

        _print_launch_warning
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
        LIST_JSON="false"
        LIST_LIMIT=10
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --json) LIST_JSON="true"; shift ;;
                --limit)
                    [[ $# -ge 2 && "$2" =~ ^[0-9]+$ && "$2" -ge 1 && "$2" -le 1000 ]] \
                        || { echo "ERROR: --limit must be an integer from 1 to 1000" >&2; exit 1; }
                    LIST_LIMIT="$2"
                    shift 2
                    ;;
                *) echo "ERROR: unknown list argument '$1'" >&2; exit 1 ;;
            esac
        done
        if [[ "$LIST_JSON" == "true" ]]; then
            _session_rows "$LIST_LIMIT" | _session_rows_json
            exit 0
        fi
        echo "=== Running tmux sessions (${AGENT_NAME}) ==="
        mtmux list-sessions 2>/dev/null \
            | grep "^${TMUX_SESSION_PREFIX}-${AGENT_NAME}" || echo "(none)"
        echo ""
        echo "=== On-disk sessions — last ${LIST_LIMIT} (${AGENT_NAME}) ==="
        _session_rows "$LIST_LIMIT" | while IFS=$'\t' read -r id updated_epoch cwd; do
            ts=$(date --utc --date="@$updated_epoch" +%F 2>/dev/null || echo "?")
            printf "  %s  %s  %s\n" "$id" "$ts" "$cwd"
        done
        ;;

    inspect)
        SESSION_ID="${1:-}"
        shift || true
        INSPECT_JSON="false"
        [[ "$SESSION_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] \
            || { echo "ERROR: a complete session UUID is required" >&2; exit 1; }
        if [[ "${1:-}" == "--json" ]]; then
            INSPECT_JSON="true"
            shift
        fi
        [[ $# -eq 0 ]] || { echo "ERROR: unknown inspect argument '$1'" >&2; exit 1; }
        SESSION_FILE=$(_session_file "$SESSION_ID")
        [[ -n "$SESSION_FILE" ]] || { echo "ERROR: session not found: $SESSION_ID" >&2; exit 3; }
        if [[ "$INSPECT_JSON" == "true" ]]; then
            _session_row "$SESSION_FILE" | _session_rows_json
        else
            _session_row "$SESSION_FILE"
        fi
        ;;

    writer-status)
        SESSION_ID="${1:-}"
        shift || true
        WRITER_ARGS=(--agent "$AGENT_NAME" --session "$SESSION_ID")
        if [[ "${1:-}" == "--json" ]]; then
            WRITER_ARGS+=(--json)
            shift
        fi
        [[ $# -eq 0 ]] || { echo "ERROR: unknown writer-status argument '$1'" >&2; exit 1; }
        node "$SCRIPT_DIR/session-writer-status.mjs" "${WRITER_ARGS[@]}"
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
