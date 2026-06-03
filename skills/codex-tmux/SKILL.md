---
name: Codex tmux Bridge
description: Resume, send prompts to, and read responses from Codex CLI sessions running inside tmux. Use when the user wants to interact with a Codex session by ID, continue previous Codex work, or the MCP codex-reply returns "Session not found".
allowed-tools: [Bash]
---

# Codex tmux Bridge

Control **Codex CLI** sessions via tmux. Reaches on-disk sessions that the MCP server no longer tracks.

## Setup

```bash
# Set once per shell, or export in your profile:
export AGENT_MESH_ROOT="<path-to-agent-mesh-repo>"
BIN="$AGENT_MESH_ROOT/packages/tmux-bridge/bin"
```

## Commands

### Resume an on-disk session

```bash
TARGET=$($BIN/agent-session.sh --agent codex resume <SESSION_ID>)
```

### Start a new session

```bash
TARGET=$($BIN/agent-session.sh --agent codex new /path/to/project)
```

### Send a prompt, get reply

```bash
$BIN/agent-send.sh --agent codex "$TARGET" "your prompt here"
# with custom timeout (seconds):
$BIN/agent-send.sh --agent codex "$TARGET" "long task" 300
```

### Read output / status

```bash
$BIN/agent-read.sh --agent codex "$TARGET" --status      # idle | working | error
$BIN/agent-read.sh --agent codex "$TARGET" --last-reply
$BIN/agent-read.sh --agent codex "$TARGET" --full
```

### List sessions

```bash
$BIN/agent-session.sh --agent codex list
```

## Key Details

- **Submit key**: Codex TUI uses `C-m`, not `Enter` — handled automatically
- **Reconnection**: WebSocket drops auto-recover via HTTPS; `agent-send.sh` polls through it
- **CWD picker**: auto-confirmed on resume (selects session directory)
- **MCP vs tmux**: use MCP for ephemeral sessions; use this skill for on-disk/resumed sessions
