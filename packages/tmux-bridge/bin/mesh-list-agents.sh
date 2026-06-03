#!/bin/bash
# mesh-list-agents.sh — List agents from the mesh registry.
#
# Usage:
#   mesh-list-agents.sh [--json]
#
# Reads mesh/registry.json and prints a table of agents
# (name, agent_type, tmux_target, capabilities, status).
# With --json, emits the raw registry JSON instead.
#
# Environment overrides:
#   AGENT_MESH_ROOT     repo root (auto-derived from script location if unset)
#   MESH_REGISTRY       path to registry.json (default: ../mesh/registry.json)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_MESH_ROOT="${AGENT_MESH_ROOT:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"
BRIDGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MESH_REGISTRY="${MESH_REGISTRY:-$BRIDGE_DIR/mesh/registry.json}"

AS_JSON="false"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --json) AS_JSON="true"; shift ;;
        -h|--help) sed -n '/^#/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "ERROR: unknown argument '$1'" >&2; exit 1 ;;
    esac
done

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

headers = ("NAME", "AGENT_TYPE", "TMUX_TARGET", "CAPABILITIES", "STATUS")
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
