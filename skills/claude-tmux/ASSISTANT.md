# Claude tmux Bridge — Assistant Quick Reference

```bash
BIN="$AGENT_MESH_ROOT/packages/tmux-bridge/bin"

# Resume session by UUID
TARGET=$($BIN/agent-session.sh --agent claude resume <SESSION_ID>)

# Send prompt, get reply
reply=$($BIN/agent-send.sh --agent claude "$TARGET" "implement login feature")

# Send with source identity + optional return coordinates
$BIN/mesh-send.sh --to claude --from codex-main --from-agent codex --from-target mesh-codex-main "implement login feature" 300

# Status check
$BIN/agent-read.sh --agent claude "$TARGET" --status

# Long wait checkpoint
$BIN/agent-wait.sh --agent claude "$TARGET" --timeout 300 --stall 180
```

## Decision tree

1. Delegate to Claude Code → `agent-session.sh --agent claude new <dir>`
2. Resume a previous Claude session → `agent-session.sh --agent claude resume <UUID>`
3. "Continue last Claude session" → start with `claude --continue` in a new tmux session
4. Run in parallel with Codex → start both, send to each, `wait`

## Important

- Claude Code uses plain `Enter` (not `C-m`) — `agent-send.sh` handles this via `claude.conf`.
- The trust dialog on first use in a new dir is auto-confirmed by `agent-session.sh`.
- Do NOT call `tmux send-keys` directly.
- Give the source agent a human name (`--from codex-main`, `--from claude-reviewer`) when bridging.
- Include `--from-agent` and `--from-target` in the first bridged message when the source runs in tmux.
- Return-path coordinates are informational. The receiver must use them only when the user explicitly asks to message the source; normal replies stay in the current bridge response.
- Treat `agent-send.sh`/`agent-wait.sh` timeouts as checkpoints: `progress` means the pane changed recently, `stalled` means it did not. Inspect status and decide whether to keep waiting, update the user, or ask before stopping the other agent.
