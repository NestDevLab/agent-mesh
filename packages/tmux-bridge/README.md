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
| `bin/agent-watch.py` | Follow persisted Codex/Claude transcripts by session id |
| `bin/agent-link.mjs` | Connect two watched sessions with a bounded Mesh v1 relay |
| `bin/mesh-list-agents.sh` | Discover mesh-capable configs and live tmux targets |
| `bin/mesh-capacity-dispatch.mjs` | Persist/retry Limen-deferred work without sleeping |
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

Prerequisites: `bash`, `tmux`, `python3`, `ss`, and the target agent CLI
(`codex`, `claude`, or another configured agent).

```bash
BIN="packages/tmux-bridge/bin"   # relative to repo root

# Resume a Codex session
TARGET=$($BIN/agent-session.sh --agent codex resume <SESSION_ID>)
$BIN/agent-send.sh --agent codex "$TARGET" "describe the project state"

# Start a Claude Code session (Remote Control is enabled by default)
TARGET=$($BIN/agent-session.sh --agent claude new /path/to/project)
reply=$($BIN/agent-send.sh --agent claude "$TARGET" "review for security issues" 300)
echo "$reply"

# Check status, read last reply
$BIN/agent-read.sh --agent codex "$TARGET" --status      # idle | working | approval-pending | error
$BIN/agent-read.sh --agent codex "$TARGET" --last-reply

# Arm at EOF, then drain only events committed after that point
python3 $BIN/agent-watch.py <SESSION_ID> --agent codex \
  --state /path/to/cursor.json --init
python3 $BIN/agent-watch.py <SESSION_ID> --agent codex \
  --state /path/to/cursor.json --drain --format jsonl

# Connect two sessions: one bounded return A -> B -> A
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/agent-mesh/codex-claude-link.json"
$BIN/agent-link.mjs --mode bidirectional --state "$STATE" \
  --left-agent codex --left-session <CODEX_ID> --left-target <CODEX_TMUX> \
  --right-agent claude --right-session <CLAUDE_ID> --right-target <CLAUDE_TMUX> \
  --init
$BIN/agent-link.mjs --mode bidirectional --state "$STATE" \
  --left-agent codex --left-session <CODEX_ID> --left-target <CODEX_TMUX> \
  --right-agent claude --right-session <CLAUDE_ID> --right-target <CLAUDE_TMUX>

# List on-disk sessions + running tmux sessions
$BIN/agent-session.sh --agent codex list

# Discover live mesh agents and send by logical name
$BIN/mesh-list-agents.sh
$BIN/mesh-send.sh --to codex "summarize the current branch" 120

# Governed background work: no prompt is pasted until Limen admits it.
export LIMEN_POLICY=/path/to/limen-policy.json
$BIN/mesh-send.sh --to codex --class L3 --run-id nightly-42 \
  "continue the authorized backlog" 300

# The caller schedules this at the earliest retryAt; the drain never sleeps.
node $BIN/mesh-capacity-dispatch.mjs drain \
  --state "${XDG_STATE_HOME:-$HOME/.local/state}/agent-mesh/capacity-queue.json"

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

`agent-watch.py` is read-only with respect to the watched session. It resolves
the newest matching transcript on each poll, writes only the caller-provided
cursor file, and supports Codex and Claude without requiring a tmux target. Its
structured output is intended for existing Mesh transports; the watcher does
not dispatch, resume, or wake an agent by itself.

For Codex and Claude, `mesh-send.sh` first discovers the dedicated
`<provider>-broker-policy-v2.json`, then falls back to
`<provider>-shadow-policy-v2.json` and the legacy `<provider>-shadow-policy.json`
during additive fleet migration. An explicit `LIMEN_POLICY` overrides all three.
This keeps broker enforcement independent from harness hook telemetry. When a policy is available, the script calls the
admission broker before `agent-send.sh`. A defer is written to a mode-0600
caller-owned queue and exits 75 with `retryAt`, `decisionId`, `configHash`,
class, and reasons. L1 is the only fail-open default; explicit L2/L3 refuses to
run when no policy is present.
The dispatcher never polls a spinner to decide capacity and never reinjects a
deferred prompt. A successful foreground send reconciles its Limen lease.
It also appends a mode-0600 replay stream at `<state>.events.ndjson` by default
or the explicit `--events` path. Events contain only a SHA-256 run identity,
provider, harness, class, lifecycle status, attempt/backlog counts, bounded
reason, and decision/config identifiers. Raw run/session IDs, commands, prompts,
and task bodies are excluded. Pass that stream to `limen replay --queue` together
with Limen's schema-v4 evidence. `--eligible-work` lets a governed caller declare
its current authorized backlog size; drain derives it from the claimed due set.
After delivery begins, a persistence failure is classified as `dispatch_unknown`
and never retried automatically. This leaves a visible reconciliation item instead
of risking a duplicate prompt.

Governed Codex mesh sessions start with
`agents.max_concurrent_threads_per_session=2`. This statically bounds the
aggregate native-subagent exposure that Limen cannot intercept per spawn. Set
`CODEX_MESH_SUBAGENT_CAP` to a positive integer for an explicitly governed run;
the normal raw `-c` passthrough remains the strongest single-run override.

`agent-link.mjs` composes that watcher with `agent-send.sh` and the existing
Mesh v1 `final`, `seen`, `hop`, and `dispatch_once` policy. It buffers transcript
events and wakes the peer only after `turn_complete`. Bidirectional mode permits
one bounded return (`A -> B -> A`, hop limit 2); unidirectional mode requires
`--direction left-to-right|right-to-left` and permits no return. The watched
sessions may be arbitrary persisted sessions, but each writable destination
must also have a live tmux bridge target, normally created with
`agent-session.sh ... resume <SESSION_ID>`.

Link state and its durable outbox live only at the explicit `--state` path; use
an XDG runtime/state directory, never the repository. A failed or interrupted
send is marked uncertain and stops automatic delivery. Resolve it explicitly
with `--retry-delivery <ID>` or `--drop-delivery <ID>` to avoid duplicate wakes.

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

When the driven agent blocks on an interactive approval dialog (detected via the
per-agent `AGENT_APPROVAL_PATTERN`, matched against the pane tail), the state is
`approval-pending` with exit `6`: `agent-read.sh --status` reports it,
`agent-wait.sh` and `agent-read.sh --follow` exit immediately, and
`agent-send.sh` refuses to paste or submit because its submit key would
blind-confirm the dialog. Only a human can answer it (attach to the tmux
target), or relaunch the session with an explicit approval policy:
`agent-session.sh --agent codex --approval-policy never new …` maps to
`codex -a/--ask-for-approval` on both `new` and `resume`. Accepted values are
`untrusted`, `on-request`, and `never`; they are validated before spawning,
since the CLI exits on an unknown one. `never` stops approval prompts but keeps
the sandbox, so sandbox-blocked commands fail back to the model instead of
asking.

For large prompts, `agent-send.sh` waits for bracketed-paste rendering to settle
before submitting, then confirms the submit with a real working/done marker
instead of treating any pane repaint as success.

## Codex Desktop visibility (remote mode)

Bridge Codex sessions show up **inside Codex Desktop automatically** whenever the
desktop app-server has a listening socket — no env var to remember. `codex.conf`
checks the known app-server socket candidates in order and adds `--remote
unix://…` only for the first candidate that is actually listening. If no
candidate is live, the bridge falls back to a standalone tmux-only Codex session
instead of failing on a stale socket file. The fallback prints a warning to
stderr so a missing Desktop attachment is visible at spawn time. Overrides:

| Want | Do |
|---|---|
| Default (auto-attach when socket is live) | nothing |
| Force a specific socket | `export CODEX_REMOTE_SOCK=/path/to.sock` |
| Force standalone, tmux-only (no desktop) | `export CODEX_NO_REMOTE=1` |

```bash
# Visible in Codex Desktop AND rooted in the project — just:
TARGET=$($BIN/agent-session.sh --agent codex new /path/to/project)

# Optional readable Desktop title, applied on the first real prompt:
TARGET=$($BIN/agent-session.sh --agent codex \
  --title "agent-mesh: review tmux adapter" \
  new /path/to/project mesh-codex-review)
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
to coexist. When raw passthrough already sets `model` or
`model_reasoning_effort`, the bridge omits its default pin for that key instead
of emitting two competing values. Each invocation rebuilds this command from
its own arguments, so no passthrough state is shared between spawns.

## Claude Remote Control visibility

Bridge Claude sessions start and resume locally by default. Remote Control must
be enabled explicitly when desktop or mobile visibility is needed. A named tmux
target still gives the session a readable mesh identity:

```bash
TARGET=$($BIN/agent-session.sh --agent claude new /path/to/project mesh-claude-review)
```

Anything after `--` is still forwarded to Claude Code, so per-session flags can
be layered on top without bypassing the bridge.

### Codex Desktop titles

Codex CLI 0.143.0 does not expose a launch `--title`/`--name` flag. The bridge's
`--title` option stores a pending title for the tmux target; `agent-send.sh`
consumes it once and prepends it as the first line of the first real prompt.
That keeps the first Desktop title readable without editing Codex's SQLite DB or
restarting Desktop. The tradeoff is that the title line is part of the first user
message and appears only after that first prompt is sent.

For already-created sessions, see `../../docs/codex-session-titles.md` for the DB
rename fallback and its Desktop restart caveat.

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
| Remote visibility | auto-detected Codex app-server | explicit `--remote-control` opt-in |
| Approval-dialog detection | footer "Press enter to confirm" | not wired yet |
| `--approval-policy` | `-a/--ask-for-approval` | unsupported (hard error) |
