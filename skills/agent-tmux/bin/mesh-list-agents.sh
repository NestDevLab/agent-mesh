#!/bin/bash
# mesh-list-agents.sh — List mesh-capable agent configs and live tmux sessions.
#
# Usage:
#   mesh-list-agents.sh [--json]
#
# Discovers agents from agents/*.conf and live sessions from the dedicated mesh
# tmux socket. With --json, emits the discovered state as JSON.
#
# Environment overrides:
#   AGENT_MESH_ROOT     repo root (auto-derived from script location if unset)
#   MESH_REGISTRY       optional legacy registry.json path; if set, read it
#   TMUX_SESSION_PREFIX tmux name prefix (default: "mesh")

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_MESH_ROOT="${AGENT_MESH_ROOT:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"
BRIDGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
AGENTS_DIR="$BRIDGE_DIR/agents"
MODELS_BIN="$SCRIPT_DIR/mesh-models.sh"
TMUX_SESSION_PREFIX="${TMUX_SESSION_PREFIX:-mesh}"

# Dedicated tmux socket (see _mesh-tmux.sh).
# shellcheck source=/dev/null
source "$SCRIPT_DIR/_mesh-tmux.sh"

AS_JSON="false"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --json) AS_JSON="true"; shift ;;
        -h|--help) sed -n '/^#/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "ERROR: unknown argument '$1'" >&2; exit 1 ;;
    esac
done

if [[ -n "${MESH_REGISTRY:-}" ]]; then
    [[ -f "$MESH_REGISTRY" ]] || { echo "ERROR: registry not found: $MESH_REGISTRY" >&2; exit 1; }
    if [[ "$AS_JSON" == "true" ]]; then
        cat "$MESH_REGISTRY"
        exit 0
    fi
    python3 - "$MESH_REGISTRY" <<'PY'
import json, sys

with open(sys.argv[1]) as fh:
    data = json.load(fh)

agents = data.get("agents", [])
rows = []
for a in agents:
    rows.append((
        a.get("name", "?"),
        a.get("agent_type", "?"),
        a.get("tmux_target", "?"),
        ",".join(a.get("capabilities", [])),
        a.get("status", "?"),
    ))

headers = ("NAME", "AGENT_TYPE", "TMUX_TARGETS", "CAPABILITIES", "STATUS")
widths = [len(h) for h in headers]
for row in rows:
    for i, cell in enumerate(row):
        widths[i] = max(widths[i], len(cell))

fmt = "  ".join("{:<%d}" % w for w in widths)
print(fmt.format(*headers))
print(fmt.format(*("-" * w for w in widths)))
for row in rows:
    print(fmt.format(*row))
PY
    exit 0
fi

emit_rows() {
    local conf agent_type name capabilities targets status prefix
    shopt -s nullglob
    for conf in "$AGENTS_DIR"/*.conf; do
        agent_type="$(basename "$conf" .conf)"
        MESH_AGENT_NAME=""
        MESH_AGENT_CAPABILITIES=""
        # shellcheck source=/dev/null
        source "$conf"
        name="${MESH_AGENT_NAME:-$agent_type}"
        capabilities="${MESH_AGENT_CAPABILITIES:-}"
        prefix="${TMUX_SESSION_PREFIX}-${agent_type}"
        targets="$(mtmux list-sessions -F '#S' 2>/dev/null \
            | while IFS= read -r session; do
                [[ "$session" == "$prefix" || "$session" == "$prefix"-* ]] && printf '%s\n' "$session"
              done \
            | paste -sd, - || true)"
        status="offline"
        [[ -n "$targets" ]] && status="online"
        printf '%s\t%s\t%s\t%s\t%s\n' "$name" "$agent_type" "$targets" "$capabilities" "$status"
    done
}

emit_model_summaries() {
    local conf agent_type report
    shopt -s nullglob
    for conf in "$AGENTS_DIR"/*.conf; do
        agent_type="$(basename "$conf" .conf)"
        if ! report="$("$MODELS_BIN" --agent "$agent_type" --json 2>/dev/null)"; then
            printf 'models: %s: unavailable\n' "$agent_type"
            continue
        fi
        if ! python3 -c '
import json
import sys

agent = sys.argv[1]
payload = json.load(sys.stdin)
item = payload["agents"][0]
pin = item["pinned_model"] or "none"
if item["probe"] == "unavailable":
    print(f"models: {agent}: no probe available, pin={pin}")
else:
    new_count = len(item["new_nudged_models"])
    suffix = ", deprecated" if item["pin_status"] == "deprecated" else ""
    print(f"models: {agent}: {new_count} new nudged, pin={pin}{suffix}")
' "$agent_type" <<<"$report"
        then
            printf 'models: %s: unavailable\n' "$agent_type"
        fi
    done
    shopt -u nullglob
}

if [[ "$AS_JSON" == "true" ]]; then
    emit_rows | python3 -c '
import json, sys

agents = []
for line in sys.stdin:
    name, agent_type, targets, capabilities, status = line.rstrip("\n").split("\t")
    target_list = [t for t in targets.split(",") if t]
    cap_list = [c for c in capabilities.split(",") if c]
    item = {
        "name": name,
        "agent_type": agent_type,
        "tmux_targets": target_list,
        "capabilities": cap_list,
        "status": status,
    }
    if target_list:
        item["tmux_target"] = target_list[0]
    agents.append(item)

print(json.dumps({"agents": agents}, indent=2))
'
    exit 0
fi

emit_rows | python3 -c '
import sys

rows = []
for line in sys.stdin:
    rows.append(tuple(line.rstrip("\n").split("\t")))

headers = ("NAME", "AGENT_TYPE", "TMUX_TARGETS", "CAPABILITIES", "STATUS")
widths = [len(h) for h in headers]
for row in rows:
    for i, cell in enumerate(row):
        widths[i] = max(widths[i], len(cell))

fmt = "  ".join("{:<%d}" % w for w in widths)
print(fmt.format(*headers))
print(fmt.format(*("-" * w for w in widths)))
for row in rows:
    print(fmt.format(*row))
'

emit_model_summaries
