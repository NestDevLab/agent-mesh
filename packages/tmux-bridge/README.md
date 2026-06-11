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
| `bin/agent-wait.sh` | Wait for a turn with progress/stalled checkpoints |
| `bin/agent-read.sh` | Read pane output (`--full`, `--last-reply`, `--status`) |
| `bin/mesh-list-agents.sh` | Discover mesh-capable configs and live tmux targets |
| `bin/mesh-send.sh` | Send to an agent by name or capability using live tmux discovery |

## Agent Configs

| File | Agent |
|---|---|
| `agents/codex.conf` | Codex CLI (`codex resume`, `C-m` submit) |
| `agents/claude.conf` | Claude Code CLI (`claude --resume`, `Enter` submit) |

Add `agents/<name>.conf` to support additional CLIs.

Agent configs may also expose mesh metadata:

```bash
MESH_AGENT_NAME="codex"
MESH_AGENT_CAPABILITIES="code,review,plan"
```

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

# Discover live mesh agents and send by logical name
$BIN/mesh-list-agents.sh
$BIN/mesh-send.sh --to codex "summarize the current branch" 120

# Send with source identity and optional return coordinates
$BIN/mesh-send.sh --to claude \
  --from codex-main \
  --from-agent codex \
  --from-target mesh-codex-main \
  "review the current branch" \
  300

# Long waits use checkpoint semantics
$BIN/agent-wait.sh --agent claude "$TARGET" --timeout 300 --stall 180
```

`mesh-send.sh` does not require a checked-in runtime registry. It discovers
agent types from `agents/*.conf` and running targets from the dedicated tmux
socket. If multiple sessions exist for the same agent type, it prefers
`mesh-<agent>-main`; otherwise pass `--target <TMUX_TARGET>`.

When `--from-agent` and `--from-target` are supplied, `mesh-send.sh` includes an
informational return path in the message header. The receiver must use that path
only when the user explicitly asks to message the source agent; normal replies
stay in the current bridge response.

`agent-send.sh` and `agent-wait.sh` treat timeouts as checkpoints. If the pane
changed recently, they return `progress` / `PROGRESS` with exit `4`; if the pane
has not changed for the stall window, they return `stalled` / `STALLED` with exit
`124`. The caller LLM should inspect status and decide whether to keep waiting,
update the user, or ask before stopping the other agent.

## Codex Desktop visibility (remote mode)

Bridge Codex sessions show up **inside Codex Desktop automatically** whenever the
desktop app-server socket is live — no env var to remember. `codex.conf`
auto-detects `~/.codex/app-server-control/desktop-ssh-websocket-v0.sock` and adds
`--remote unix://…` when it exists. Overrides:

| Want | Do |
|---|---|
| Default (auto-attach when socket is live) | nothing |
| Force a specific socket | `export CODEX_REMOTE_SOCK=/path/to.sock` |
| Force standalone, tmux-only (no desktop) | `export CODEX_NO_REMOTE=1` |

```bash
# Visible in Codex Desktop AND rooted in the project — just:
TARGET=$($BIN/agent-session.sh --agent codex new /path/to/project)
```

**Working-directory gotcha:** in remote mode the app-server ignores the
`tmux -c <cwd>` the bridge sets — a plain `codex --remote …` lands in the
*server's* cwd (typically `$HOME`), not your project. The `new` command fixes
this by passing the resolved directory through the `{CWD}` placeholder in
`codex.conf`, which expands to `codex --remote … --cd "<project>"`. So a session
started with `new /path/to/project` is both rooted in that project **and**
visible from the desktop. Verify with a `pwd` probe if in doubt.

> Note: this `{CWD}` pinning applies to `new`. A `resume` in remote mode relies
> on Codex restoring the session's own recorded cwd.

### Extra launch flags — never bypass the bridge

Anything after `--` is forwarded verbatim to the agent CLI, so per-session knobs
like reasoning effort no longer require hand-rolling a raw `codex` command (which
is exactly how sessions historically lost `--remote` *and* `--cd`):

```bash
# xhigh + correct cwd + Codex Desktop visibility, all in one bridge call:
$BIN/agent-session.sh --agent codex new "$WORKTREE" mesh-codex-b1 \
  -- -c model_reasoning_effort=xhigh
```

`--remote` and `-c` overrides (e.g. `model_reasoning_effort=xhigh`) are verified
to coexist — the remote app-server honors the per-session override.

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `MESH_TMUX_SOCKET` | `mesh` | Dedicated tmux socket (`tmux -L`) for all bridge sessions |
| `TMUX_SESSION_PREFIX` | `mesh` | Prefix for tmux session names |
| `MESH_REGISTRY` | unset | Optional legacy registry path; dynamic discovery is used when unset |
| `AGENT_POLL_INTERVAL` | `2` | Seconds between output polls |
| `AGENT_IDLE_ROUNDS` | `3` | Stable-output rounds before declaring idle |
| `AGENT_STALL_TIMEOUT` | `300` | Seconds without pane changes before checkpointing as stalled |

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
