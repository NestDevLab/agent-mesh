#!/usr/bin/env bash
# Process-level writer ownership checks for persisted Claude sessions.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STATUS="$BRIDGE_DIR/bin/session-writer-status.mjs"
SESSION_ID="writer-test-$$"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-mesh-writer-test.XXXXXX")"
CLAUDE_INVENTORY="$WORKDIR/claude-inventory"
DESKTOP_PID=""
CLI_PID=""
MONITOR_PID=""

cleanup() {
    [[ -z "$CLI_PID" ]] || kill "$CLI_PID" 2>/dev/null || true
    [[ -z "$DESKTOP_PID" ]] || kill "$DESKTOP_PID" 2>/dev/null || true
    [[ -z "$MONITOR_PID" ]] || kill "$MONITOR_PID" 2>/dev/null || true
    [[ -z "$CLI_PID" ]] || wait "$CLI_PID" 2>/dev/null || true
    [[ -z "$DESKTOP_PID" ]] || wait "$DESKTOP_PID" 2>/dev/null || true
    [[ -z "$MONITOR_PID" ]] || wait "$MONITOR_PID" 2>/dev/null || true
    rm -rf "$WORKDIR"
}
trap cleanup EXIT INT TERM

# Keep this process-level fixture independent of whether the CI image installs
# Claude Code. The ownership implementation still performs the real inventory
# call, but this disposable provider returns a valid empty inventory so the test
# exercises process classification without relying on host state.
cat > "$CLAUDE_INVENTORY" <<'CLI'
#!/usr/bin/env bash
if [[ "${1:-}" == "agents" && "${2:-}" == "--json" ]]; then
    printf '[]\n'
    exit 0
fi
exit 64
CLI
chmod +x "$CLAUDE_INVENTORY"
export CLAUDE_BIN="$CLAUDE_INVENTORY"

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

start_fake_writer() {
    local argv_zero="$1"
    bash -c 'exec -a "$1" node -e "setInterval(() => {}, 1000)" -- "--resume=$2"' \
        _ "$argv_zero" "$SESSION_ID" &
    FAKE_PID=$!
}

wait_for_kind() {
    local kind="$1" attempts=0
    while (( attempts < 100 )); do
        if node "$STATUS" --agent claude --session "$SESSION_ID" --json \
            | python3 -c "import json,sys; raise SystemExit(not any(w['kind'] == '$kind' for w in json.load(sys.stdin)['writers']))"; then
            return 0
        fi
        sleep 0.02
        attempts=$((attempts + 1))
    done
    return 1
}

start_fake_writer "/tmp/.claude/remote/ccd-cli/test-version"
DESKTOP_PID="$FAKE_PID"
wait_for_kind claude-desktop || fail "Claude Desktop writer was not detected"
node "$STATUS" --agent claude --session "$SESSION_ID" --require-kind claude-desktop >/dev/null
if node "$STATUS" --agent claude --session "$SESSION_ID" --require-free >/dev/null 2>&1; then
    fail "occupied Desktop session was reported free"
fi

INBOX="$WORKDIR/inbox.jsonl"
CURSOR="$WORKDIR/cursor.json"
: > "$INBOX"
node "$BRIDGE_DIR/bin/agent-inbox-watch.mjs" \
    --inbox "$INBOX" --state "$CURSOR" --follow >/dev/null &
MONITOR_PID=$!
attempts=0
while (( attempts < 100 )); do
    if node "$STATUS" --agent claude --session "$SESSION_ID" \
        --require-monitor-inbox "$INBOX" >/dev/null 2>&1; then
        break
    fi
    sleep 0.02
    attempts=$((attempts + 1))
done
(( attempts < 100 )) || fail "event-driven Monitor watcher was not detected"
if node "$STATUS" --agent claude --session "$SESSION_ID" \
    --require-monitor-inbox "$WORKDIR/other.jsonl" >/dev/null 2>&1; then
    fail "wrong Monitor inbox passed the watcher contract"
fi

start_fake_writer "claude"
CLI_PID="$FAKE_PID"
wait_for_kind claude-cli || fail "Claude CLI writer was not detected"
if node "$STATUS" --agent claude --session "$SESSION_ID" --require-kind claude-desktop >/dev/null 2>&1; then
    fail "dual-writer session passed the exactly-one Desktop contract"
fi
if node "$STATUS" --agent claude --session "$SESSION_ID" --forbid-kind claude-desktop >/dev/null 2>&1; then
    fail "Desktop writer bypassed the tmux transport guard"
fi

echo "PASS: Claude session writer ownership"
