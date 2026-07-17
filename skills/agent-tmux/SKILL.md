---
name: agent-tmux-bridge
description: "Use only when tmux/agent-mesh is the requested transport: start/resume persistent CLI sessions, inspect/message existing mesh sessions, bridge different runtimes, or recover lost MCP sessions. For same-runtime subagents, use native delegation by default; use this bridge only if the user asks for tmux/agent-mesh/session resume or native delegation is unavailable."
allowed-tools: [Bash]
---

# Agent tmux Bridge

Control **Codex CLI** and **Claude Code CLI** sessions via tmux with one
agent-agnostic toolset. The same `bin/` scripts drive any agent through a
`--agent <type>` flag; per-agent quirks (submit key, prompt char, idle/working
patterns, launch flags) live in `agents/<type>.conf`. Reaches on-disk sessions
that an agent's own MCP server no longer tracks.

This is the **tmux transport** for the mesh: any agent that can run these scripts
can pilot supported CLI agents through persistent tmux sessions.

## Use Policy

- Same-runtime fan-out uses native delegation by default.
- Do not use this bridge just to create another worker of your own runtime.
- Use it for explicit tmux/agent-mesh, session start/resume, existing mesh
  session control, cross-runtime delegation, or native-unavailable fallback.
- If using it as fallback, state why.

## Setup

```bash
SKILL_DIR="${SKILL_DIR:-$PWD}"   # the installed skill directory
BIN="$SKILL_DIR/bin"

# Repository mode (running from the agent-mesh checkout):
export AGENT_MESH_ROOT="<path-to-agent-mesh-repo>"
BIN="${AGENT_MESH_ROOT}/packages/tmux-bridge/bin"
```

Prerequisites: `bash`, `tmux`, `python3`, `ss`, and the target agent CLI (`codex`
and/or `claude`). All sessions share the dedicated tmux socket `mesh`
(`tmux -L mesh`), kept alive with `exit-empty off` — never the default server.
Read-only attach: `tmux -L mesh attach -t <target> -r`; detach with `Ctrl-b d`.

## Who can drive whom

| Caller \\ Target | Codex | Claude |
|---|---|---|
| **Claude** | `--agent codex` | `--agent claude` |
| **Codex**  | `--agent codex` | `--agent claude` |

Same-type tmux control is supported, but native same-runtime delegation remains
the default. The caller only needs shell access to `bin/`.

## Commands

Pick the target with `--agent codex` or `--agent claude` — everything else is
identical.

### Start / resume

After every `new` or `resume`, relay the `ATTACH:` command printed on stderr to
the user. For read-only monitoring, use its `tmux -L mesh attach -r -t <target>`
variant.

```bash
# New session in a directory (prints the tmux target on stdout):
TARGET=$($BIN/agent-session.sh --agent codex  new /path/to/project)
TARGET=$($BIN/agent-session.sh --agent claude new /path/to/project)

# New Codex session with a readable Codex Desktop title:
TARGET=$($BIN/agent-session.sh --agent codex \
  --title "agent-mesh: review tmux adapter" \
  new /path/to/project mesh-codex-review)

# Model and effort are first-class launch options for both new and resume:
TARGET=$($BIN/agent-session.sh --agent codex \
  --model gpt-5.6-luna --effort xhigh \
  new /path/to/project mesh-codex-review)

# Resume an on-disk session by ID:
TARGET=$($BIN/agent-session.sh --agent codex resume <SESSION_ID>)

# List configured agents + live sessions:
$BIN/agent-session.sh --agent codex list
$BIN/mesh-list-agents.sh            # all agents, live targets, capabilities
```

### Send a prompt, read the reply

```bash
# Prompts go via tmux paste-buffer — multiline and special chars are safe.
$BIN/agent-send.sh --agent codex "$TARGET" "your prompt here" [timeout]

$BIN/agent-read.sh --agent codex "$TARGET" --status      # idle | working | error
$BIN/agent-read.sh --agent codex "$TARGET" --last-reply
$BIN/agent-read.sh --agent codex "$TARGET" --full
$BIN/agent-read.sh --agent codex "$TARGET" --follow
```

For delegation, run one foreground `agent-send.sh`; it streams readable worker
progress to stderr by default while keeping the extracted reply on stdout. Use
`agent-read.sh --follow` to watch a session you did not start, and `--quiet` on
`agent-send.sh` for programmatic callers that need clean stderr.

`agent-send.sh`/`agent-wait.sh` treat the timeout as a **checkpoint**, not a
hard stop: exit `4`/`PROGRESS` if the pane changed recently, exit `124`/`STALLED`
if it has not. Inspect status and decide whether to keep waiting, report
progress, or ask before stopping the other agent.

Exit `5` means the tmux target exists but no longer shows a live agent TUI (for
example, the CLI died and left bash in the pane). The prompt is not pasted and
the submit retry loop stops; use `agent-session.sh … resume` or `new` first.

```bash
state=$($BIN/agent-wait.sh --agent claude "$TARGET" --timeout 300 --poll 8 --stall 180)
```

### Model, effort, and raw launch flags

`--model <name>` and `--effort <level>` work with `new` and `resume`. Their
per-agent mapping lives in `agents/<type>.conf`: Codex maps them to its config
overrides, while Claude accepts `--model` and hard-errors on unsupported
`--effort`.

Codex workers pin `gpt-5.6-terra` with `high` reasoning by default on both new
and resumed sessions, independent of the Desktop model picker. Set
`CODEX_MESH_MODEL` and/or `CODEX_MESH_EFFORT` to replace those defaults, or
`CODEX_MESH_PIN=0` to follow the Desktop config. Precedence (weakest to
strongest): pinned default, environment override, `--model`/`--effort`, raw
passthrough after `--`.

Anything after `--` is forwarded verbatim to the agent CLI, so per-session knobs
no longer require a hand-rolled command (which is how sessions historically lost
`--remote` and `--cd`):

```bash
# Raw flags are last and override first-class flags when the CLI supports both:
$BIN/agent-session.sh --agent codex new "$WORKTREE" mesh-codex-b1 \
  --effort high -- -c model_reasoning_effort=low
```

### Model discovery and pin freshness

`$BIN/mesh-models.sh [--agent codex|claude|--all] [--json] [--refresh]` reports
advertised models, models newly seen by the mesh, the effective bridge pin, and
an advisory `STALE-PIN` review hint. It **never auto-bumps a pin** or writes a
harness config: model promotion is a human decision. Discovery is declared by
each config's read-only `AGENT_MODELS_PROBE_CMD`; Codex reads its config signals
best-effort, while Claude currently reports `no probe available`. Text runs add
models to the local seen cache; `--refresh` replaces it, and plain `--json`
remains read-only for scheduled consumers.

## Desktop / mobile visibility

Claude bridge sessions start and resume with Claude Code Remote Control enabled
by default (`claude --remote-control`), so they are visible from Claude Desktop /
mobile without remembering a passthrough flag. A named tmux target is still
useful for a readable mesh identity:

```bash
TARGET=$($BIN/agent-session.sh --agent claude new /path/to/project mesh-claude-review)
```

Codex bridge sessions use the Codex Desktop app-server path described below.

## Codex Desktop visibility

Codex bridge sessions attach to the desktop **app-server automatically** whenever
its socket is live — they show up inside Codex Desktop and are co-pilotable from
mobile over the remote-control tunnel. No env var to remember.

- `codex.conf` checks the known app-server socket candidates in order and adds
  `--remote unix://…` only for the first candidate that is actually listening; if
  none is live, it falls back to a standalone tmux-only session. It also passes
  `--cd "<dir>"` in remote mode (the app-server ignores `tmux -c`, so this keeps
  the session in the right project).
- Use `agent-session.sh --agent codex --title "<short title>" new ...` for a
  readable Desktop title. The bridge stores the title for that tmux target and
  `agent-send.sh` prepends it as the first line of the first real prompt, so no
  DB edit or Desktop restart is needed. Limit: the title is visible after the
  first prompt is sent, and that title line is part of the first user message.
- Override: `CODEX_REMOTE_SOCK=/path.sock` forces a socket; `CODEX_NO_REMOTE=1`
  forces a standalone, tmux-only session (use for long unattended runs you want
  isolated from daemon restarts).
- `--remote` coexists with `-c` overrides (verified: `model_reasoning_effort=xhigh`).

For already-created sessions only, DB rename is a fallback with a Desktop restart
caveat; see `docs/codex-session-titles.md`.

## Cross-agent delegation

When one agent delegates to another, give the source a human name and include
its coordinates in the first message:

```bash
$BIN/mesh-send.sh \
  --to codex --from claude-reviewer --from-agent claude \
  --from-target mesh-claude-reviewer --intent request \
  "your prompt here" 300
```

Return-path coordinates are **informational**. The receiver uses them only when
the user explicitly asks to message the source back; a normal reply stays in the
current bridge response and must not start a bridge call back.

## Anti-recursion & fan-out safety

The mesh has no built-in depth limit — agents driving agents can fan out or loop.
Hold these rules:

- **Default depth is 1.** You drive workers; workers do **not** spawn further
  agents unless the user explicitly asked for multi-level orchestration. If you
  delegate, tell the worker to do the task and report back — not to bridge again.
- **No cycles.** If A drove B, B must not drive A. Combined with the return-path
  rule above, this prevents reply/spawn loops.
- **Reuse before spawning.** Run `mesh-list-agents.sh` (or `agent-session.sh
  --agent <t> list`) first and reuse a live session instead of piling up
  duplicates. Sessions persist on the `mesh` socket across turns.
- **Make nesting visible.** Name child sessions so the chain is legible
  (`mesh-codex-b1`, `mesh-codex-b1-helper`) and pass `--from` so provenance
  headers show who spawned whom.
- **Bound the fan-out.** Cap concurrent children to what the task needs; don't
  launch a worker per item without a ceiling.
- **Approvals are transitive.** A spawned agent that commits, pushes, deploys, or
  sends anything external is still bound by the user's git/safety rules. Pass
  those constraints down explicitly; do not let delegation launder an action the
  user has not approved.

## Repository/source-of-truth sync

When changing this skill or the local runtime-b installation, keep `agent-mesh` as
the source of truth: patch the repo, run its verification, commit and push, then
sync a trusted local copy into runtime-b and archive conflicting local helper skills.
See `references/agent-mesh-repo-sync.md` for the full sequence and pitfalls.

## Known gotchas

- **Submit key differs per agent.** Codex submits with `C-m`, Claude with
  `Enter`. `agent-send.sh` handles this via the conf — never call
  `tmux send-keys … Enter` directly for prompt text.
- **Visibility.** Keep the `ATTACH:` hint from `agent-session.sh`; use
  `attach -r` for pure monitoring. A foreground `agent-send.sh` is the primary
  live-delegation path; use `agent-read.sh --follow` for an existing session and
  `agent-send.sh --quiet` when stderr must stay machine-clean.
- **Multiline / special chars.** `agent-send.sh` injects prompts via
  `tmux paste-buffer`; always use it, never raw `send-keys`.
- **Large prompts.** `agent-send.sh` waits for bracketed-paste rendering to
  settle before submitting, then confirms submit via working/done markers. This
  is not reliable while the pane is actively repainting (e.g. a fresh Codex
  session still printing MCP-startup warnings): the submit can be swallowed and
  a large multiline paste can arrive interleaved/corrupted. Mitigate — on a new
  session, poll `--status` until `idle` before the first `agent-send`; keep
  prompts small or pass them via a file instead of a huge inline heredoc; if a
  send lands mid-startup (prompt sits un-submitted, or `--status` shows
  `error`), `kill` the session, start a fresh one, and resend once `idle`.
- **Codex trust dialog.** New directories prompt a workspace-trust dialog;
  `agent-session.sh` auto-confirms with Enter. If stuck, check `--status` and
  capture the pane with `--full`.
- **Codex app-server socket mismatch.** Without a live `CODEX_REMOTE_SOCK`,
  `codex resume` may try a dead control socket and fail with
  `WebSocket protocol error: Connection reset…`. The auto-detect above resolves
  this when the desktop app-server is up; otherwise `ss -x | grep codex` to find
  a live socket.
- **Queued input survives a kill.** A session killed while it still has queued
  input can execute that input late (observed: a `git commit` fired after the
  session was killed). After killing a session mid-task, verify the real
  side-effect state (`git status` / `git log`) instead of assuming nothing ran.
