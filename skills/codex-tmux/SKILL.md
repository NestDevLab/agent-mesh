---
name: Codex tmux Bridge
description: Resume, send prompts to, and read responses from Codex CLI sessions running inside tmux. Use when the user wants to interact with a Codex session by ID, continue previous Codex work, or the MCP codex-reply returns "Session not found".
allowed-tools: [Bash]
---

# Codex tmux Bridge

Control **Codex CLI** sessions via tmux. Reaches on-disk sessions that the MCP server no longer tracks.

## Setup

```bash
export AGENT_MESH_ROOT="<path-to-agent-mesh-repo>"
BIN="$AGENT_MESH_ROOT/packages/tmux-bridge/bin"

# If a Codex app-server is running (common in VS Code / desktop setups),
# export the socket path so resume connects to it instead of the missing control socket:
export CODEX_REMOTE_SOCK="$HOME/.codex/app-server-control/desktop-ssh-websocket-v0.sock"
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
# Prompts are sent via tmux paste-buffer — special chars and multiline are safe.
$BIN/agent-send.sh --agent codex "$TARGET" "your prompt here"

# With custom timeout (seconds):
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

## Known Gotchas

### App-server socket mismatch
In environments with a running Codex app-server (VS Code, desktop), `codex resume`
may try to connect to `app-server-control.sock` which has no listener and fail with:
`WebSocket protocol error: Connection reset without closing handshake`

**Fix:** export `CODEX_REMOTE_SOCK` pointing to the live socket before running:
```bash
export CODEX_REMOTE_SOCK="$HOME/.codex/app-server-control/desktop-ssh-websocket-v0.sock"
# Check which sockets are actually listening:
ss -x | grep codex
```

### Multiline / special-char prompts
`tmux send-keys` misinterprets newlines as Enter and special chars like `(` as shell syntax.
**Fix:** `agent-send.sh` uses `tmux paste-buffer` to inject prompts safely — always use the script, never raw `tmux send-keys` for prompt text.

### Trust dialog on new directories
Codex shows a workspace-trust prompt for new directories. `agent-session.sh` auto-confirms it with Enter. If it gets stuck, check with `--status` and capture the pane with `--full`.

### Submit key
Codex TUI uses `C-m` (carriage-return), not plain `Enter`. `agent-send.sh` handles this via `codex.conf` — do not call `tmux send-keys` directly.
