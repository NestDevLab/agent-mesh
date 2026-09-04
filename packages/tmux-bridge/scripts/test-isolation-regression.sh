#!/usr/bin/env bash
# Run the complete bridge suite in a private runtime and prove it did not alter
# either the operational graph or the package's checked-in agent configs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HOST_STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
DEFAULT_GRAPH="$HOST_STATE_HOME/agent-mesh/graph"
RUN_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/agent-mesh-test-runtime.XXXXXX")"
TEST_STATE="$RUN_ROOT/state"
TEST_AGENTS="$RUN_ROOT/agents"
BEFORE_GRAPH="$RUN_ROOT/default-graph.before"
BEFORE_AGENTS="$RUN_ROOT/package-agents.before"
AFTER_GRAPH="$RUN_ROOT/default-graph.after"
AFTER_AGENTS="$RUN_ROOT/package-agents.after"
BEFORE_EVENTS="$RUN_ROOT/default-graph.events.before.jsonl"

snapshot() {
    local path="$1" output="$2" file rel digest
    if [[ ! -e "$path" ]]; then
        printf 'absent\n' > "$output"
        return
    fi
    {
        printf 'present\n'
        while IFS= read -r -d '' file; do
            rel="${file#"$path"/}"
            digest="$(sha256sum -- "$file")"
            printf '%s\t%s\n' "$rel" "$digest"
        done < <(find "$path" -type f -print0 | sort -z)
    } > "$output"
}

cleanup() {
    rm -rf "$RUN_ROOT"
}
trap cleanup EXIT INT TERM

snapshot "$DEFAULT_GRAPH" "$BEFORE_GRAPH"
snapshot "$BRIDGE_DIR/agents" "$BEFORE_AGENTS"
if [[ -f "$DEFAULT_GRAPH/events.jsonl" ]]; then
    cp "$DEFAULT_GRAPH/events.jsonl" "$BEFORE_EVENTS"
else
    : > "$BEFORE_EVENTS"
fi
mkdir -p "$TEST_AGENTS"
cp "$BRIDGE_DIR/agents/"*.conf "$TEST_AGENTS/"

export XDG_STATE_HOME="$TEST_STATE"
export MESH_GRAPH_STATE="$TEST_STATE/agent-mesh/graph"
export MESH_GRAPH_DISABLE=0
export AGENT_MESH_AGENTS_DIR="$TEST_AGENTS"

cd "$BRIDGE_DIR"
node --test test/*.test.mjs
scripts/socket-isolation-test.sh
scripts/smoke-test.sh
scripts/agent-send-readiness-test.sh
python3 scripts/idle-expiry-test.py
scripts/launch-options-test.sh
scripts/mesh-cli-smoke.sh
scripts/session-writer-test.sh
scripts/session-watch-test.sh
scripts/session-link-test.sh
scripts/desktop-session-link-test.sh

snapshot "$DEFAULT_GRAPH" "$AFTER_GRAPH"
snapshot "$BRIDGE_DIR/agents" "$AFTER_AGENTS"
if ! cmp -- "$BEFORE_GRAPH" "$AFTER_GRAPH" >/dev/null; then
    # graph.json may legitimately refresh while the suite is running. Its
    # append-only events remain sufficient to prove that this suite registered
    # no fixture session in the operational graph.
    node - "$BEFORE_EVENTS" "$DEFAULT_GRAPH/events.jsonl" <<'NODE'
const fs = require("fs");
const before = fs.readFileSync(process.argv[2], "utf8");
const currentPath = process.argv[3];
const current = fs.existsSync(currentPath) ? fs.readFileSync(currentPath, "utf8") : "";
if (!current.startsWith(before)) throw new Error("default graph event stream was rewritten during the suite");
const fixtureTarget = /^(?:iso-(?:live|transient)-|mesh-(?:smoke|bash-smoke|idle-expiry-test)-|launch-options-|mesh-codex-main$)/;
for (const line of current.slice(before.length).trim().split("\n")) {
  if (!line) continue;
  const event = JSON.parse(line);
  const target = event.node?.tmuxTarget;
  if (typeof target === "string" && fixtureTarget.test(target)) {
    throw new Error(`suite fixture reached default graph: ${target}`);
  }
}
NODE
fi
cmp -- "$BEFORE_AGENTS" "$AFTER_AGENTS" \
    || { echo "FAIL: full bridge suite modified package agents directory" >&2; exit 1; }

echo "PASS: full bridge suite leaves no fixture events in the default graph and leaves package agents untouched"
