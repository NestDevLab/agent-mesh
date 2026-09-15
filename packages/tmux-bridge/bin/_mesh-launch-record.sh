# _mesh-launch-record.sh — append-only provenance for sessions launched by the bridge.

MESH_LAUNCH_RECORD_BIN="${MESH_LAUNCH_RECORD_BIN:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bridge-launch-record.py}"
MESH_LAUNCH_RECORD_FILE="${MESH_LAUNCH_RECORD_FILE:-${XDG_STATE_HOME:-$HOME/.local/state}/agent-mesh/launches/events.jsonl}"

mesh_launch_caller() {
    local caller="${CODEX_COMPANION_SESSION_ID:-${CODEX_THREAD_ID:-${CLAUDE_SESSION_ID:-unknown}}}"
    printf '%s\n' "$caller"
}

mesh_launch_record_start() {
    local agent="$1" target="$2" cwd="$3" profile="$4" thread_id="$5" route_status="$6" route_reason="${7:-}" launched_at_ms="${8:-}"
    local args route_json="${MESH_LIMEN_ROUTE:-}" model="${SESSION_MODEL:-}" effort="${SESSION_EFFORT:-}"
    args=(--state "$MESH_LAUNCH_RECORD_FILE" start --agent "$agent" --target "$target" --cwd "$cwd"
        --route-status "$route_status" --caller "$(mesh_launch_caller)")
    [[ -z "$profile" ]] || args+=(--profile "$profile")
    [[ -z "$thread_id" ]] || args+=(--thread-id "$thread_id")
    [[ -z "$route_reason" ]] || args+=(--route-reason "$route_reason")
    [[ -z "$route_json" ]] || args+=(--route-json "$route_json")
    [[ -z "$model" ]] || args+=(--model "$model")
    [[ -z "$effort" ]] || args+=(--effort "$effort")
    [[ -z "$launched_at_ms" ]] || args+=(--launched-at-ms "$launched_at_ms")
    python3 "$MESH_LAUNCH_RECORD_BIN" "${args[@]}" >/dev/null
}

mesh_launch_record_reconcile() {
    local agent="$1" target="$2"
    local db="${CODEX_STATE_DB:-${CODEX_HOME:-$HOME/.codex}/state_5.sqlite}"
    python3 "$MESH_LAUNCH_RECORD_BIN" --state "$MESH_LAUNCH_RECORD_FILE" reconcile \
        --agent "$agent" --target "$target" --codex-db "$db"
}
