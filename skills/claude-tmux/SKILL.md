---
name: Claude tmux Bridge
description: Resume, send prompts to, and read responses from Claude Code CLI sessions running inside tmux. Use when delegating work to Claude Code, continuing a previous Claude session, or running Claude and Codex in parallel.
allowed-tools: [Bash]
---

# Claude tmux Bridge

Control **Claude Code CLI** sessions via tmux from within Codex (or any other caller).

## Setup

Installed mode (agentwheel): use the scripts bundled inside this skill directory.
Run commands from the installed skill directory, or set `SKILL_DIR` explicitly.

```bash
SKILL_DIR="${SKILL_DIR:-$PWD}"
BIN="$SKILL_DIR/bin"
```

Repository mode remains supported:

```bash
export AGENT_MESH_ROOT="<path-to-agent-mesh-repo>"
BIN="${AGENT_MESH_ROOT}/packages/tmux-bridge/bin"
```

Prerequisites: `bash`, `tmux`, `python3`, and the `claude`/`codex` CLIs you want to control.

## Commands

### Resume an existing session

```bash
TARGET=$($BIN/agent-session.sh --agent claude resume <SESSION_ID>)
```

### Start a new session

```bash
TARGET=$($BIN/agent-session.sh --agent claude new /path/to/project)
```

### Send a prompt, get reply

```bash
reply=$($BIN/agent-send.sh --agent claude "$TARGET" "your task" 300)
echo "$reply"
```

### Read output / status

```bash
$BIN/agent-read.sh --agent claude "$TARGET" --status
$BIN/agent-read.sh --agent claude "$TARGET" --last-reply
```

### List sessions

```bash
$BIN/agent-session.sh --agent claude list
```

## Parallel pattern

```bash
T_C=$($BIN/agent-session.sh --agent codex  new ~/project codex-backend)
T_L=$($BIN/agent-session.sh --agent claude new ~/project claude-frontend)

$BIN/agent-send.sh --agent codex  "$T_C" "implement REST API"  &
$BIN/agent-send.sh --agent claude "$T_L" "implement React UI"  &
wait
```

## Key Differences vs Codex

| | Claude Code | Codex |
|---|---|---|
| Submit key | `Enter` | `C-m` |
| Prompt char | `❯` | `›` |
| Done signal | `✻ Brewed for Xs` | `Working` disappears |
| Resume cmd | `claude --resume <UUID>` | `codex resume <UUID>` |
| CWD picker | no | yes |
