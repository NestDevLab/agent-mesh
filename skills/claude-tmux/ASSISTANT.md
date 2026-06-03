# Claude tmux Bridge — Assistant Quick Reference

```bash
BIN="$AGENT_MESH_ROOT/packages/tmux-bridge/bin"

# Resume session by UUID
TARGET=$($BIN/agent-session.sh --agent claude resume <SESSION_ID>)

# Send prompt, get reply
reply=$($BIN/agent-send.sh --agent claude "$TARGET" "implement login feature")

# Status check
$BIN/agent-read.sh --agent claude "$TARGET" --status
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
