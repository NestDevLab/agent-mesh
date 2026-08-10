#!/bin/bash
# mesh-send.sh — Ergonomic mesh send: resolve a logical agent name (or capability)
# from agent configs + live tmux sessions, then dispatch via agent-send.sh.
#
# Usage:
#   mesh-send.sh --to <NAME> [--target <TMUX_TARGET>] [--intent request|reply|notification] [--from <NAME>] [--from-agent <TYPE>] [--from-target <TMUX_TARGET>] <BODY> [TIMEOUT]
#   mesh-send.sh --capability <CAP> [--target <TMUX_TARGET>] [--intent ...] [--from <NAME>] [--from-agent <TYPE>] [--from-target <TMUX_TARGET>] <BODY> [TIMEOUT]
#
# Resolution:
#   --to <NAME>          look up the agent by agents/*.conf metadata
#   --capability <CAP>   pick the first online agent whose config lists CAP
#
# The resolved agent yields an agent_type (config) and a live tmux target. If no
# session is running, this prints an error telling you to start it with
# agent-session.sh. It never auto-starts a session.
#
# A provenance header is prepended to the body before dispatch. When source
# coordinates are supplied, it also includes a return path that the receiver must
# use only if the user explicitly asks to message the source agent.
# The agent reply is printed to stdout.
#
# Environment overrides:
#   AGENT_MESH_ROOT     repo root (auto-derived from script location if unset)
#   MESH_REGISTRY       optional legacy registry.json path; if set, read it
#   MESH_FROM           default sender name for the provenance header (default: "mesh")
#   MESH_FROM_AGENT     default source agent type for return-path metadata
#   MESH_FROM_TARGET    default source tmux target for return-path metadata
#   TMUX_SESSION_PREFIX tmux name prefix (default: "mesh")
#   LIMEN_POLICY        optional Limen policy; when set, admission precedes delivery
#   LIMEN_BIN           Limen executable (default: limen)
#   MESH_CAPACITY_STATE persistent caller-owned queue path

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_MESH_ROOT="${AGENT_MESH_ROOT:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"
BIN_DIR="$SCRIPT_DIR"
BRIDGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
AGENTS_DIR="$BRIDGE_DIR/agents"
SEND_BIN="$BIN_DIR/agent-send.sh"
TMUX_SESSION_PREFIX="${TMUX_SESSION_PREFIX:-mesh}"

# Dedicated tmux socket (see _mesh-tmux.sh) — must match the bridge scripts.
# shellcheck source=/dev/null
source "$SCRIPT_DIR/_mesh-tmux.sh"

TO=""
CAPABILITY=""
TARGET_OVERRIDE=""
INTENT="request"
FROM="${MESH_FROM:-mesh}"
FROM_AGENT="${MESH_FROM_AGENT:-}"
FROM_TARGET="${MESH_FROM_TARGET:-}"
WORK_CLASS="L1"
RUN_ID=""
PROJECT=""
MODEL=""
EFFORT=""
ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --to)         TO="$2"; shift 2 ;;
        --capability) CAPABILITY="$2"; shift 2 ;;
        --target)     TARGET_OVERRIDE="$2"; shift 2 ;;
        --intent)     INTENT="$2"; shift 2 ;;
        --from)       FROM="$2"; shift 2 ;;
        --from-agent) FROM_AGENT="$2"; shift 2 ;;
        --from-target) FROM_TARGET="$2"; shift 2 ;;
        --class)       WORK_CLASS="$2"; shift 2 ;;
        --run-id)      RUN_ID="$2"; shift 2 ;;
        --project)     PROJECT="$2"; shift 2 ;;
        --model)       MODEL="$2"; shift 2 ;;
        --effort)      EFFORT="$2"; shift 2 ;;
        -h|--help)    sed -n '/^#/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)            ARGS+=("$1"); shift ;;
    esac
done
set -- "${ARGS[@]:-}"

BODY="${1:-}"
TIMEOUT="${2:-120}"

[[ -x "$SEND_BIN" ]] || { echo "ERROR: missing executable: $SEND_BIN" >&2; exit 1; }
[[ -z "$BODY" ]] && { echo "ERROR: message BODY required" >&2; exit 1; }
[[ -z "$TO" && -z "$CAPABILITY" ]] && { echo "ERROR: one of --to or --capability is required" >&2; exit 1; }

case "$INTENT" in
    request|reply|notification) ;;
    *) echo "ERROR: invalid --intent '$INTENT' (use request|reply|notification)" >&2; exit 1 ;;
esac
case "$WORK_CLASS" in L1|L2|L3) ;; *) echo "ERROR: invalid capacity class '$WORK_CLASS'" >&2; exit 1 ;; esac

if [[ -n "${MESH_REGISTRY:-}" ]]; then
    [[ -f "$MESH_REGISTRY" ]] || { echo "ERROR: registry not found: $MESH_REGISTRY" >&2; exit 1; }
    # Resolve target → tab-separated: name<TAB>agent_type<TAB>tmux_target<TAB>status
    RESOLVED="$(python3 - "$MESH_REGISTRY" "$TO" "$CAPABILITY" <<'PY'
import json, sys

registry, to, capability = sys.argv[1], sys.argv[2], sys.argv[3]
with open(registry) as fh:
    agents = json.load(fh).get("agents", [])

match = None
if to:
    for a in agents:
        if a.get("name") == to:
            match = a
            break
else:
    for a in agents:
        if a.get("status") == "online" and capability in a.get("capabilities", []):
            match = a
            break

if match is None:
    sys.exit(3)

print("\t".join([
    match.get("name", ""),
    match.get("agent_type", ""),
    match.get("tmux_target", ""),
    match.get("status", ""),
]))
PY
    )" || {
        if [[ -n "$TO" ]]; then
            echo "ERROR: no agent named '$TO' in registry: $MESH_REGISTRY" >&2
        else
            echo "ERROR: no online agent with capability '$CAPABILITY' in registry: $MESH_REGISTRY" >&2
        fi
        exit 1
    }

    IFS=$'\t' read -r R_NAME R_TYPE R_TARGET R_STATUS <<<"$RESOLVED"
else
    R_NAME=""
    R_TYPE=""
    R_TARGET=""
    R_STATUS=""

    shopt -s nullglob
    for conf in "$AGENTS_DIR"/*.conf; do
        agent_type="$(basename "$conf" .conf)"
        MESH_AGENT_NAME=""
        MESH_AGENT_CAPABILITIES=""
        # shellcheck source=/dev/null
        source "$conf"
        name="${MESH_AGENT_NAME:-$agent_type}"
        capabilities=",${MESH_AGENT_CAPABILITIES:-},"

        if [[ -n "$TO" && "$name" != "$TO" && "$agent_type" != "$TO" ]]; then
            continue
        fi
        if [[ -n "$CAPABILITY" && "$capabilities" != *",$CAPABILITY,"* ]]; then
            continue
        fi

        prefix="${TMUX_SESSION_PREFIX}-${agent_type}"
        targets="$(mtmux list-sessions -F '#S' 2>/dev/null \
            | while IFS= read -r session; do
                [[ "$session" == "$prefix" || "$session" == "$prefix"-* ]] && printf '%s\n' "$session"
              done || true)"
        [[ -n "$targets" || -n "$TO" ]] || continue

        R_NAME="$name"
        R_TYPE="$agent_type"
        R_STATUS="offline"
        [[ -n "$targets" ]] && R_STATUS="online"

        if [[ -n "$TARGET_OVERRIDE" ]]; then
            R_TARGET="$TARGET_OVERRIDE"
        else
            preferred="${TMUX_SESSION_PREFIX}-${agent_type}-main"
            if echo "$targets" | grep -qx "$preferred"; then
                R_TARGET="$preferred"
            else
                count="$(echo "$targets" | grep -c . || true)"
                if [[ "$count" -eq 1 ]]; then
                    R_TARGET="$targets"
                elif [[ "$count" -gt 1 ]]; then
                    echo "ERROR: multiple running tmux sessions for agent '$R_NAME'; pass --target." >&2
                    echo "$targets" | sed 's/^/       /' >&2
                    exit 1
                fi
            fi
        fi
        break
    done
fi

[[ -n "$R_TYPE" ]] || {
    if [[ -n "$TO" ]]; then
        echo "ERROR: no agent named '$TO' (expected config in $AGENTS_DIR)" >&2
    else
        echo "ERROR: no agent with capability '$CAPABILITY' is online" >&2
    fi
    exit 1
}
[[ -n "$R_TARGET" ]] || {
    echo "ERROR: no running tmux session for agent '$R_NAME'." >&2
    echo "       Start it first, e.g.:" >&2
    echo "         $BIN_DIR/agent-session.sh --agent $R_TYPE new <CWD> ${TMUX_SESSION_PREFIX}-${R_TYPE}-main" >&2
    exit 1
}

if ! mtmux has-session -t "$R_TARGET" 2>/dev/null; then
    echo "ERROR: tmux session '$R_TARGET' for agent '$R_NAME' is not running." >&2
    echo "       Start it first, e.g.:" >&2
    echo "         $BIN_DIR/agent-session.sh --agent $R_TYPE new <CWD> $R_TARGET" >&2
    exit 1
fi

# Provenance header prepended to the body. It is emitted as leading comment
# lines ("# ...") so shell-like receivers treat it as inert metadata while agent
# CLIs still see it at the top of the message.
HEADER="# [mesh from=${FROM} to=${R_NAME} intent=${INTENT}]"
if [[ -n "$FROM_AGENT" || -n "$FROM_TARGET" ]]; then
    HEADER="$(printf '%s\n# [mesh-source name=%s agent=%s target=%s]' "$HEADER" "$FROM" "${FROM_AGENT:-unknown}" "${FROM_TARGET:-unknown}")"
    HEADER="$(printf '%s\n# Return path is informational only: use it only when the user explicitly asks you to message the source agent.' "$HEADER")"
    if [[ -n "$FROM_AGENT" && -n "$FROM_TARGET" ]]; then
        HEADER="$(printf '%s\n# Return command: %s/agent-send.sh --agent %s %q \"<message>\" <checkpoint_seconds>' "$HEADER" "$BIN_DIR" "$FROM_AGENT" "$FROM_TARGET")"
    fi
fi

DEFAULT_LIMEN_POLICY="${XDG_CONFIG_HOME:-$HOME/.config}/limen/${R_TYPE}-shadow-policy.json"
if [[ -z "${LIMEN_POLICY:-}" && ( "$R_TYPE" == "codex" || "$R_TYPE" == "claude" ) && -f "$DEFAULT_LIMEN_POLICY" ]]; then
    LIMEN_POLICY="$DEFAULT_LIMEN_POLICY"
fi
if [[ "$WORK_CLASS" != "L1" && -z "${LIMEN_POLICY:-}" ]]; then
    echo "ERROR: L2/L3 mesh work requires a Limen policy; expected LIMEN_POLICY or $DEFAULT_LIMEN_POLICY" >&2
    exit 1
fi

PROMPT="$(printf '%s\n%s' "$HEADER" "$BODY")"
if [[ "$WORK_CLASS" != "L1" && "$R_TYPE" != "codex" && "$R_TYPE" != "claude" ]]; then
    echo "ERROR: Limen M1 does not govern background agent type '$R_TYPE'" >&2
    exit 1
fi
if [[ -n "${LIMEN_POLICY:-}" && ( "$R_TYPE" == "codex" || "$R_TYPE" == "claude" ) ]]; then
    DISPATCHER="$BIN_DIR/mesh-capacity-dispatch.mjs"
    STATE="${MESH_CAPACITY_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/agent-mesh/capacity-queue.json}"
    [[ -n "$RUN_ID" ]] || RUN_ID="mesh-${R_TARGET}-$(date +%s%N)"
    CAPACITY_ARGS=(submit --state "$STATE" --limen "${LIMEN_BIN:-limen}" --policy "$LIMEN_POLICY" --provider "$R_TYPE" --harness "$R_TYPE" --run-id "$RUN_ID" --class "$WORK_CLASS" --session "$R_TARGET")
    [[ -n "$PROJECT" ]] && CAPACITY_ARGS+=(--project "$PROJECT")
    [[ -n "$MODEL" ]] && CAPACITY_ARGS+=(--model "$MODEL")
    [[ -n "$EFFORT" ]] && CAPACITY_ARGS+=(--effort "$EFFORT")
    exec node "$DISPATCHER" "${CAPACITY_ARGS[@]}" -- "$SEND_BIN" --agent "$R_TYPE" "$R_TARGET" "$PROMPT" "$TIMEOUT"
fi
exec "$SEND_BIN" --agent "$R_TYPE" "$R_TARGET" "$PROMPT" "$TIMEOUT"
