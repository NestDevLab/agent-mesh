---
name: claude-tmux-bridge
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

The timeout is a checkpoint. If the other agent is still producing pane output,
`agent-send.sh` exits `4` with a `PROGRESS` status instead of waiting forever. If
the pane has not changed recently, it exits `124` with `STALLED`.

When delegating from one agent to another, give the source a human name and
include source coordinates in the first message:

```bash
$BIN/mesh-send.sh \
  --to claude \
  --from codex-main \
  --from-agent codex \
  --from-target mesh-codex-main \
  --intent request \
  "your task" \
  300
```

The receiving agent may use the source coordinates only when the user explicitly
asks it to send a message back to the source. A normal reply must stay in the
current bridge response and must not start a bridge call back.

### Read output / status

```bash
$BIN/agent-read.sh --agent claude "$TARGET" --status
$BIN/agent-read.sh --agent claude "$TARGET" --last-reply
```

### Wait with checkpoints

Use `agent-wait.sh` for long-running work when you need a robust wait without
blocking indefinitely:

```bash
state=$($BIN/agent-wait.sh --agent claude "$TARGET" --timeout 300 --poll 8 --stall 180)
case "$state" in
  idle*)     $BIN/agent-read.sh --agent claude "$TARGET" --last-reply ;;
  progress*) $BIN/agent-read.sh --agent claude "$TARGET" --status ;;
  stalled*)  $BIN/agent-read.sh --agent claude "$TARGET" --status ;;
  dead*)     echo "Claude session ended" ;;
esac
```

On `progress`, inspect status and decide whether to continue waiting, report
that the other agent is still working, or ask the user what to do. On `stalled`,
inspect the pane/status and ask before stopping or replacing the other agent
unless the user already authorized that action.

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
