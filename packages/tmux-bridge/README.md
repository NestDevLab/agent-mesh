# @openclaw-agent-mesh/tmux-bridge

Agnostic tmux bridge for **CLI-to-CLI agent intercommunication**.

Any agent CLI (Codex, Claude Code, Gemini…) can control any other via tmux — no MCP server restart required, works with on-disk sessions.

## Why

MCP servers keep session state in memory only — a restart loses everything. But agent CLIs persist full conversation logs to disk and support `--resume <UUID>`. The tmux bridge reopens those sessions and allows programmatic prompt dispatch from any caller.

## Scripts

| Script | Purpose |
|---|---|
| `bin/agent-session.sh` | Create, resume, list, or kill agent sessions in tmux |
| `bin/agent-send.sh` | Send a prompt and wait for the reply |
| `bin/agent-read.sh` | Read pane output (`--full`, `--last-reply`, `--status`) |

## Agent Configs

| File | Agent |
|---|---|
| `agents/codex.conf` | Codex CLI (`codex resume`, `C-m` submit) |
| `agents/claude.conf` | Claude Code CLI (`claude --resume`, `Enter` submit) |

Add `agents/<name>.conf` to support additional CLIs.

## Usage

```bash
BIN="packages/tmux-bridge/bin"   # relative to repo root

# Resume a Codex session
TARGET=$($BIN/agent-session.sh --agent codex resume <SESSION_ID>)
$BIN/agent-send.sh --agent codex "$TARGET" "describe the project state"

# Start a Claude Code session
TARGET=$($BIN/agent-session.sh --agent claude new /path/to/project)
reply=$($BIN/agent-send.sh --agent claude "$TARGET" "review for security issues" 300)
echo "$reply"

# Check status, read last reply
$BIN/agent-read.sh --agent codex "$TARGET" --status      # idle | working | error
$BIN/agent-read.sh --agent codex "$TARGET" --last-reply

# List on-disk sessions + running tmux sessions
$BIN/agent-session.sh --agent codex list
```

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `MESH_TMUX_SOCKET` | `mesh` | Dedicated tmux socket (`tmux -L`) for all bridge sessions |
| `TMUX_SESSION_PREFIX` | `mesh` | Prefix for tmux session names |
| `AGENT_POLL_INTERVAL` | `2` | Seconds between output polls |
| `AGENT_IDLE_ROUNDS` | `3` | Stable-output rounds before declaring idle |

## Session isolation & durability

The bridge never uses the default tmux server. All sessions run on a **dedicated
socket** (`MESH_TMUX_SOCKET`, default `mesh`) and the server is set to
`exit-empty off`. This is deliberate and load-bearing:

- **Isolation** — the user's own `tmux`, and concurrent smoke tests, cannot race
  against or kill live agent sessions. Tests run on throwaway sockets
  (`MESH_TMUX_SOCKET=mesh-…-$$`) and tear them down with `kill-server`.
- **Durability** — with tmux's default `exit-empty on`, a server self-destructs
  the instant it has zero sessions, taking every resumable agent session with it.
  `exit-empty off` keeps the mesh server alive across transient emptiness.

`exit-empty off` can only be applied **after** the first session exists (an empty
default-mode server exits before any option can be set), so `mesh_tmux_harden`
runs immediately after `new-session`. Regression test:
`scripts/socket-isolation-test.sh`.

## Agent Differences

| | Codex | Claude Code |
|---|---|---|
| Submit key | `C-m` | `Enter` |
| Prompt char | `›` | `❯` |
| Done signal | `Working` disappears | `✻ Brewed for Xs` appears |
| Resume command | `codex resume <UUID>` | `claude --resume <UUID>` |
| Session dir | `~/.codex/sessions/` | `~/.claude/projects/` |
| CWD picker on resume | yes | no |
