# Codex tmux Bridge — Assistant Quick Reference

```bash
BIN="$AGENT_MESH_ROOT/packages/tmux-bridge/bin"

# Resume session by UUID
TARGET=$($BIN/agent-session.sh --agent codex resume <SESSION_ID>)

# Send prompt, get reply
$BIN/agent-send.sh --agent codex "$TARGET" "your prompt"

# Send with source identity + optional return coordinates
$BIN/mesh-send.sh --to codex --from claude-reviewer --from-agent claude --from-target mesh-claude-reviewer "your prompt" 300

# Status check
$BIN/agent-read.sh --agent codex "$TARGET" --status   # idle | working | error

# Long wait checkpoint
$BIN/agent-wait.sh --agent codex "$TARGET" --timeout 300 --stall 180
```

## Decision tree

1. User gives a Codex session ID → `agent-session.sh --agent codex resume`
2. MCP `codex-reply` returns "Session not found" → fall back here
3. Fresh Codex session needed → `agent-session.sh --agent codex new <dir>`

## Important

- Always use `agent-send.sh` — it handles `C-m` submit and reconnection polling.
- Do NOT call `tmux send-keys … Enter` directly; Codex TUI won't submit.
- Give the source agent a human name (`--from codex-main`, `--from claude-reviewer`) when bridging.
- Include `--from-agent` and `--from-target` in the first bridged message when the source runs in tmux.
- Return-path coordinates are informational. The receiver must use them only when the user explicitly asks to message the source; normal replies stay in the current bridge response.
- Treat `agent-send.sh`/`agent-wait.sh` timeouts as checkpoints: `progress` means the pane changed recently, `stalled` means it did not. Inspect status and decide whether to keep waiting, update the user, or ask before stopping the other agent.
