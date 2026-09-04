# _mesh-graph.sh — optional bridge hooks for the local session graph.
# Sourced after _mesh-tmux.sh by lifecycle and delivery commands.

MESH_GRAPH_BIN="${MESH_GRAPH_BIN:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/mesh-graph.mjs}"

mesh_graph_enabled() {
    [[ "${MESH_GRAPH_DISABLE:-0}" != "1" ]]
}

mesh_graph_cmd() {
    local args=("$@")
    mesh_graph_enabled || return 0
    [[ -f "$MESH_GRAPH_BIN" ]] || { echo "WARN: graph command not found: $MESH_GRAPH_BIN" >&2; return 1; }
    [[ -n "${MESH_GRAPH_STATE:-}" ]] && args+=(--state "$MESH_GRAPH_STATE")
    node "$MESH_GRAPH_BIN" "${args[@]}"
}

mesh_graph_node_id_for_target() {
    local target="$1"
    mesh_graph_enabled || return 0
    mesh_graph_cmd show --json | node -e '
let body = "";
process.stdin.on("data", (chunk) => { body += chunk; });
process.stdin.on("end", () => {
  const graph = JSON.parse(body);
  const node = graph.nodes.find((item) => item.tmuxTarget === process.argv[1]);
  if (node) process.stdout.write(node.id);
});
' "$target"
}

mesh_graph_current_target() {
    [[ -n "${MESH_GRAPH_PARENT_TARGET:-}" ]] && { printf '%s\n' "$MESH_GRAPH_PARENT_TARGET"; return 0; }
    mtmux display-message -p '#S' 2>/dev/null || true
}

mesh_graph_register_session() {
    local agent="$1" target="$2" cwd="$3" role_profile="$4" title="$5" initial_summary="${6:-discovered via bridge}"
    local existing args result node_id parent_target parent_id
    mesh_graph_enabled || return 0

    existing="$(mesh_graph_node_id_for_target "$target")" || return 1
    args=(add --agent "$agent" --tmux-target "$target")
    [[ -n "$cwd" ]] && args+=(--cwd "$cwd")
    [[ -n "$role_profile" ]] && args+=(--role-profile "$role_profile")
    [[ -n "$title" ]] && args+=(--title "$title")
    [[ -z "$existing" ]] && args+=(--summary "$initial_summary")
    result="$(mesh_graph_cmd "${args[@]}" --json)" || return 1
    node_id="$(node -e 'const result = JSON.parse(process.argv[1]); process.stdout.write(result.node.id);' "$result")" || return 1

    parent_target="$(mesh_graph_current_target)"
    if [[ -n "$parent_target" && "$parent_target" != "$target" ]]; then
        parent_id="$(mesh_graph_node_id_for_target "$parent_target")" || return 1
        [[ -z "$parent_id" ]] || mesh_graph_cmd link --from "$parent_id" --to "$node_id" --type spawned-by >/dev/null
    fi
    printf '%s\n' "$node_id"
}

mesh_graph_link_targets() {
    local from_target="$1" to_target="$2" relation="$3" from_id to_id
    mesh_graph_enabled || return 0
    from_id="$(mesh_graph_node_id_for_target "$from_target")" || return 1
    to_id="$(mesh_graph_node_id_for_target "$to_target")" || return 1
    [[ -n "$from_id" && -n "$to_id" ]] || return 0
    mesh_graph_cmd link --from "$from_id" --to "$to_id" --type "$relation" >/dev/null
}

mesh_graph_reconcile_runtime() {
    local agent="$1" target="$2" runtime_uuid="$3" cwd="$4"
    local args=(add --agent "$agent" --tmux-target "$target" --runtime-uuid "$runtime_uuid")
    mesh_graph_enabled || return 0
    [[ -n "$cwd" ]] && args+=(--cwd "$cwd")
    mesh_graph_cmd "${args[@]}" --json >/dev/null
}
