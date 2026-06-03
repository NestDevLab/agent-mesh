# Codex tmux Bridge — Assistant Quick Reference

```bash
BIN="$AGENT_MESH_ROOT/packages/tmux-bridge/bin"

# Resume session by UUID
TARGET=$($BIN/agent-session.sh --agent codex resume <SESSION_ID>)

# Send prompt, get reply
$BIN/agent-send.sh --agent codex "$TARGET" "your prompt"

# Status check
$BIN/agent-read.sh --agent codex "$TARGET" --status   # idle | working | error
```

## Decision tree

1. User gives a Codex session ID → `agent-session.sh --agent codex resume`
2. MCP `codex-reply` returns "Session not found" → fall back here
3. Fresh Codex session needed → `agent-session.sh --agent codex new <dir>`

## Important

- Always use `agent-send.sh` — it handles `C-m` submit and reconnection polling.
- Do NOT call `tmux send-keys … Enter` directly; Codex TUI won't submit.
