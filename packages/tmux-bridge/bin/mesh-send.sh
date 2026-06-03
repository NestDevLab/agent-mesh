#!/bin/bash
# mesh-send.sh — Ergonomic mesh send: resolve a logical agent name (or capability)
# from the registry, then dispatch a prompt via agent-send.sh.
#
# Usage:
#   mesh-send.sh --to <NAME> [--intent request|reply|notification] [--from <NAME>] <BODY> [TIMEOUT]
#   mesh-send.sh --capability <CAP> [--intent ...] [--from <NAME>] <BODY> [TIMEOUT]
#
# Resolution:
#   --to <NAME>          look up the agent by logical name in the registry
#   --capability <CAP>   pick the first online agent whose capabilities include CAP
#
# The resolved agent yields an agent_type (config) and a tmux_target. If that
# tmux session is not running, this prints an error telling you to start it with
# agent-session.sh — it never auto-starts a session.
#
# A one-line provenance header is prepended to the body before dispatch.
# The agent reply is printed to stdout.
#
# Environment overrides:
#   AGENT_MESH_ROOT     repo root (auto-derived from script location if unset)
#   MESH_REGISTRY       path to registry.json (default: ../mesh/registry.json)
#   MESH_FROM           default sender name for the provenance header (default: "mesh")

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_MESH_ROOT="${AGENT_MESH_ROOT:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"
BIN_DIR="$SCRIPT_DIR"
BRIDGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MESH_REGISTRY="${MESH_REGISTRY:-$BRIDGE_DIR/mesh/registry.json}"
SEND_BIN="$BIN_DIR/agent-send.sh"

# Dedicated tmux socket (see _mesh-tmux.sh) — must match the bridge scripts.
# shellcheck source=/dev/null
source "$SCRIPT_DIR/_mesh-tmux.sh"

TO=""
CAPABILITY=""
INTENT="request"
FROM="${MESH_FROM:-mesh}"
ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --to)         TO="$2"; shift 2 ;;
        --capability) CAPABILITY="$2"; shift 2 ;;
        --intent)     INTENT="$2"; shift 2 ;;
        --from)       FROM="$2"; shift 2 ;;
        -h|--help)    sed -n '/^#/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)            ARGS+=("$1"); shift ;;
    esac
done
set -- "${ARGS[@]:-}"

BODY="${1:-}"
TIMEOUT="${2:-120}"

[[ -f "$MESH_REGISTRY" ]] || { echo "ERROR: registry not found: $MESH_REGISTRY" >&2; exit 1; }
[[ -x "$SEND_BIN" ]] || { echo "ERROR: missing executable: $SEND_BIN" >&2; exit 1; }
[[ -z "$BODY" ]] && { echo "ERROR: message BODY required" >&2; exit 1; }
[[ -z "$TO" && -z "$CAPABILITY" ]] && { echo "ERROR: one of --to or --capability is required" >&2; exit 1; }

case "$INTENT" in
    request|reply|notification) ;;
    *) echo "ERROR: invalid --intent '$INTENT' (use request|reply|notification)" >&2; exit 1 ;;
esac

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

[[ -n "$R_TYPE" ]] || { echo "ERROR: agent '$R_NAME' has no agent_type in registry" >&2; exit 1; }
[[ -n "$R_TARGET" ]] || { echo "ERROR: agent '$R_NAME' has no tmux_target in registry" >&2; exit 1; }

if ! mtmux has-session -t "$R_TARGET" 2>/dev/null; then
    echo "ERROR: tmux session '$R_TARGET' for agent '$R_NAME' is not running." >&2
    echo "       Start it first, e.g.:" >&2
    echo "         $BIN_DIR/agent-session.sh --agent $R_TYPE new <CWD> $R_TARGET" >&2
    exit 1
fi

# One-line provenance header prepended to the body. It is emitted as a leading
# comment line ("# ...") so shell-like receivers treat it as inert metadata while
# agent CLIs still see it as the first line of the message.
HEADER="# [mesh from=${FROM} to=${R_NAME} intent=${INTENT}]"

exec "$SEND_BIN" --agent "$R_TYPE" "$R_TARGET" "$(printf '%s\n%s' "$HEADER" "$BODY")" "$TIMEOUT"
