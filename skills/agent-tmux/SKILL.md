---
name: agent-tmux-bridge
description: "Use only when tmux/agent-mesh is the requested transport: start/resume persistent CLI sessions, inspect/message existing mesh sessions, bridge different runtimes, or recover lost MCP sessions. For Codex Desktop task-to-task work and same-runtime subagents, use native capabilities by default; use this bridge only if the user asks for tmux/agent-mesh/session resume or native control is unavailable."
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

- In Codex Desktop, use native task capabilities for Codex-to-Codex work when
  they are exposed: `send_message_to_thread` for an existing task,
  `wait_threads` or `read_thread` for observation, `create_thread` for a new
  user-visible task only after an explicit user request, and `fork_thread` when
  completed source history should carry over. Run `list_projects` before
  project-backed creation and use a worktree by default for Git projects.
- A task still being prepared may return only `clientThreadId`; wait for a real
  `threadId` before trying to read, wait on, or message it.
- Same-runtime subagent fan-out uses native delegation by default. Desktop tasks
  and subagents are different surfaces: do not create a user-owned Desktop task
  merely to obtain a hidden worker.
- Do not use this bridge just to create or message another Codex Desktop task.
- Use it for explicit tmux/agent-mesh, session start/resume, existing mesh
  session control, persistent CLI ownership, cross-runtime delegation, on-disk
  recovery, terminal-level control, or native-unavailable fallback.
- If using it as fallback, state why.
- Never emulate a missing native capability by editing Codex state or calling an
  undocumented app-server protocol method.

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

# Governed launches use exactly one routing form. A profile resolves through
# Limen, launches, and owns the lease lifecycle:
POLICY="${XDG_CONFIG_HOME:-$HOME/.config}/limen/codex-shadow-policy-v2.json"
TARGET=$($BIN/agent-spawn.sh --agent codex \
  --profile developer --limen-config "$POLICY" \
  new "$PWD" mesh-codex-developer)

# An exact persistent candidate uses the complete model+effort pair instead:
TARGET=$($BIN/agent-spawn.sh --agent codex \
  --model gpt-5.6-terra --effort high --limen-config "$POLICY" \
  new "$PWD" mesh-codex-exact)

# Resume an on-disk session by ID:
TARGET=$($BIN/agent-session.sh --agent codex resume <SESSION_ID>)

# List configured agents + live sessions:
$BIN/agent-session.sh --agent codex list
$BIN/agent-session.sh --agent codex list --json --limit 25
$BIN/agent-session.sh --agent claude inspect <SESSION_ID> --json
$BIN/agent-session.sh --agent codex writer-status <SESSION_ID> --json
$BIN/mesh-list-agents.sh            # all agents, live targets, capabilities

# Read the local graph, or reconcile a known runtime UUID after its first prompt.
$BIN/mesh-graph.mjs show --tree
$BIN/agent-session.sh --agent codex inspect <SESSION_ID> --json --graph-target mesh-codex-main
```

Do not resume a persisted session that already has a writer. For a governed
call to an active Codex session, use the native queue collector so the existing
writer owns the turn and the result remains correlated:

```bash
$BIN/agent-native-call.mjs --agent codex --session <SESSION_ID> \
  --correlation-id <TASK_ID> --message "your prompt here"
```

Claude ownership uses the documented `claude agents --json` inventory plus
process verification, so Desktop owners are found even when their argv omits
`--resume`. An incomplete inventory is unknown, not free, and resume fails
before creating tmux state.

The supported Claude CLI has no API that injects a normal user turn into an
already-active Desktop/Remote Control conversation. `--resume` may create a
copy, and cross-session `SendMessage` is an agent message rather than a user
turn. Use the same adapter for a deterministic verdict:

```bash
$BIN/agent-native-call.mjs --agent claude --session <SESSION_ID> \
  --correlation-id <TASK_ID> --message "your prompt here"
```

It exits 78 with a versioned JSON blocker and `delivery.attempted: false`. Never
substitute transcript edits, direct socket writes, or undocumented app-server
protocols. A user-visible prompt must come from that conversation's terminal,
Desktop, browser, or mobile composer until Claude exposes a supported API.

### Send a prompt, read the reply

```bash
# Prompts go via tmux paste-buffer — multiline and special chars are safe.
$BIN/agent-send.sh --agent codex "$TARGET" "your prompt here" [timeout]

$BIN/agent-read.sh --agent codex "$TARGET" --status      # idle | working | approval-pending | error
$BIN/agent-read.sh --agent codex "$TARGET" --last-reply
$BIN/agent-read.sh --agent codex "$TARGET" --full
$BIN/agent-read.sh --agent codex "$TARGET" --follow
```

For governed mesh work, use `mesh-send.sh` with an explicit class and stable run
ID. For explicit L3 work on Codex and Claude it prefers the fleet-owned broker
policy at `${XDG_CONFIG_HOME:-$HOME/.config}/limen/<provider>-broker-policy-v2.json`.
L1/L2, or L3 before that policy is installed, use
`<provider>-shadow-policy-v2.json` and then the legacy
`<provider>-shadow-policy.json` during migration. Set `LIMEN_POLICY` only to
override all discovered locations explicitly. L2/L3 fail closed if
no policy is available. Schedule a drain at the returned `retryAt`. Exit 75
means queued, not failed. Neither submit nor drain sleeps or pastes a deferred
prompt.

```bash
export LIMEN_POLICY=/path/to/limen-policy.json
$BIN/mesh-send.sh --to codex --class L3 --run-id backlog-item-42 \
  "continue the externally authorized item" 300

node "$BIN/mesh-capacity-dispatch.mjs" drain \
  --state "${XDG_STATE_HOME:-$HOME/.local/state}/agent-mesh/capacity-queue.json"
```

### Watch any persisted Codex or Claude session

Transcript watching does not require the session to have been started by this
bridge. Arm a caller-owned cursor at EOF, then drain or follow normalized events:

```bash
python3 "$BIN/agent-watch.py" <SESSION_ID> --agent codex \
  --state /path/to/cursor.json --init
python3 "$BIN/agent-watch.py" <SESSION_ID> --agent codex \
  --state /path/to/cursor.json --drain --format jsonl
```

The watcher never resumes, writes to, or attaches to the session. It writes only
the explicit cursor file. Watching is not authorization to relay: use the
existing send path only when the user has approved the target and direction.

### Adopt an existing Desktop session into the graph

Adoption is an explicit, transcript-only graph action. It neither resumes nor
attaches to the session. The runtime UUID is its idempotency key; the raw title
is evidence only, so supply the one-line graph summary separately. Quiet
adopted sessions remain active until explicitly closed.

```bash
$BIN/mesh-graph.mjs adopt --agent codex --runtime-uuid <SESSION_UUID>
$BIN/mesh-graph.mjs summary --id <NODE_ID> --summary "one compact label"
$BIN/mesh-graph.mjs ref add --id <NODE_ID> --ref source:opaque-id
$BIN/mesh-graph.mjs ref remove --runtime-uuid <SESSION_UUID> --ref source:opaque-id
```

Ref updates are idempotent and select exactly one node by graph ID or runtime
UUID. Multiple nodes may carry the same opaque ref. The graph reports those
explicit associations; it never resolves refs, selects an owner, or grants work.

### Connect two sessions

Only after the user approves the endpoints and direction, attach each writable
session to a live bridge target and initialize a caller-owned link state:

```bash
LEFT_TARGET=$($BIN/agent-session.sh --agent codex resume <CODEX_ID>)
RIGHT_TARGET=$($BIN/agent-session.sh --agent claude resume <CLAUDE_ID>)
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/agent-mesh/codex-claude-link.json"

$BIN/agent-link.mjs --mode bidirectional --state "$STATE" \
  --left-agent codex --left-session <CODEX_ID> --left-target "$LEFT_TARGET" \
  --right-agent claude --right-session <CLAUDE_ID> --right-target "$RIGHT_TARGET" \
  --init
$BIN/agent-link.mjs --mode bidirectional --state "$STATE" \
  --left-agent codex --left-session <CODEX_ID> --left-target "$LEFT_TARGET" \
  --right-agent claude --right-session <CLAUDE_ID> --right-target "$RIGHT_TARGET"
```

Bidirectional mode performs one bounded return (`A -> B -> A`) using Mesh v1
hop limit 2. Unidirectional mode requires `--direction left-to-right` or
`right-to-left` and performs one wake only. Reasoning, tool, and message events
are buffered; only `turn_complete` can produce `dispatch_once`. Keep state out of
the repository. If delivery becomes uncertain, the link fails closed and
requires explicit `--retry-delivery <ID>` or `--drop-delivery <ID>`.

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

Exit `6` / `approval-pending` means the agent is blocked on an interactive
approval dialog (e.g. a destructive-command confirmation ending in "Press enter
to confirm or esc to cancel"). `agent-read.sh --status` reports
`approval-pending`, `agent-wait.sh` and `agent-read.sh --follow` exit `6`
immediately instead of riding to a checkpoint, and `agent-send.sh` refuses to
paste or submit — its submit key would blind-confirm the dialog. Do not poll or
resend: only a human can answer it. Have the user attach (writable, no `-r`),
or relaunch the worker with an explicit `--approval-policy` (below).

```bash
state=$($BIN/agent-wait.sh --agent claude "$TARGET" --timeout 300 --poll 8 --stall 180)
```

### Profile and exact persistent routing

Choose a named profile for planned work, then inspect it without reserving a
run:

```bash
limen route --dry-run --config /path/to/limen-policy.json \
  --profile implementation.spec-defined --harness codex
```

`--config` is mandatory. Do not infer a policy from a shell default: different
policies can choose different candidate sets. Use `agent-spawn.sh`, not
`agent-session.sh`, for a new governed launch: it delegates route, admission,
lease, renewal, and completion to the existing dispatcher. A persistent session
must select exactly one form: `--profile NAME`, or both `--model MODEL
--effort LEVEL`. Partial exact input and mixing `--profile` with either exact
flag fail before launch.

The profile form calls `limen route`; the exact form calls `limen admit` with
the requested model and effort. The returned candidate identity and native
binding are authoritative and remain attached to the session lifecycle. If
Limen is unavailable, slow, or fails before dispatch, the launch keeps the
existing fail-open behavior and reports **"no route obtained"**. An explicit
exact admit without a lease is the same degraded/unavailable outcome; malformed
candidate leases still fail closed. An explicit capacity defer is different: it
is queued as `waiting_capacity` and exits 75; no prompt is launched.

The routed answer is binding: in shadow, its first candidate wins. Never replace
the returned native model or effort in the same call; correct the authored
profile instead. The dispatcher rejects a routed provider that differs from the
launch target. In particular, `architect` / `architecture.executable-specification`
must use `--agent claude`, while `reviewer` / `review.adversarial` must use
`--agent codex`.

### Native same-runtime routing

For a native child, resolve before creating the task. The command output is
mandatory task context; preserve it verbatim so the chosen profile and route are
auditable. If Limen is unavailable or slow, use the existing native behavior and
report **"no route obtained"** — never pick a replacement model by hand.

```bash
# Codex -> Codex native task: retain this complete JSON output in the task.
limen route --dry-run \
  --config "${XDG_CONFIG_HOME:-$HOME/.config}/limen/codex-shadow-policy-v2.json" \
  --profile developer --harness codex

# Claude -> Claude Agent: pass the returned nativeModel to Agent.model.
# Claude receives nativeModel. Pass effort only when the configured binding
# exposes a controllable effort; otherwise keep it as route metadata.
limen route --dry-run \
  --config "${XDG_CONFIG_HOME:-$HOME/.config}/limen/claude-shadow-policy-v2.json" \
  --profile architect --harness claude
```

For a governed persistent session, `--model <name>` and `--effort <level>` are
one exact routing form, not independent overrides. Their per-agent mapping
lives in `agents/<type>.conf`: Codex renders the returned `nativeModel` and
effort natively; Claude renders `nativeModel` and only renders effort when its
binding declares that control. If effort is not controllable, it remains in
`MESH_LIMEN_ROUTE` and the child warns that it was not applied.

Capacity handling is explicit. Without `--force`, a Limen defer waits and is
planner-drained at `retryAt`. With `--force`, only an exact pair may override a
soft capacity defer; the dispatcher launches unleased, emits
`capacity_overridden` with the requested candidate and original defer evidence,
retains that provenance through terminal session events, and makes no renew or
complete calls for that session. Hard policy/validation failures cannot be
forced. `alternate` is planner-owned.

`--approval-policy <policy>` (Codex only) is an opt-in knob for `new` and
`resume` that maps to `codex -a/--ask-for-approval`. Accepted values are
`untrusted`, `on-request`, and `never`; anything else is rejected before the
session spawns. Use it when a driven run must not block on approval dialogs.
`never` stops the prompts but keeps the sandbox, so sandbox-blocked commands
fail back to the model instead of hanging the session. Claude has no safe
mapping (only `--dangerously-skip-permissions`) and hard-errors.

```bash
TARGET=$($BIN/agent-session.sh --agent codex --approval-policy never \
  new /path/to/project mesh-codex-unattended)
```

Codex has a configured bridge pin for fail-open launches and explicit overrides.
Set `CODEX_MESH_MODEL` and/or `CODEX_MESH_EFFORT` to replace it, or
`CODEX_MESH_PIN=0` to follow the Desktop config. Precedence (weakest to
strongest): configured pin, environment override, `--model`/`--effort`, raw
passthrough after `--`. The bridge renders only the strongest mapped value for
each knob. If raw passthrough already sets that knob, it omits the mapped value
entirely, so the process command line does not contain stale-looking duplicates.

Anything after `--` is forwarded verbatim to the agent CLI, so per-session knobs
no longer require a hand-rolled command (which is how sessions historically lost
`--remote` and `--cd`):

```bash
# Raw flags replace the mapped value for the same knob:
$BIN/agent-session.sh --agent codex new "$WORKTREE" mesh-codex-b1 \
  --effort high -- -c model_reasoning_effort=low
```

### Verifying the effort a Codex session actually got

Codex accepts `minimal|low|medium|high|xhigh|max|ultra`, but each model declares
its own subset — `codex debug models` is the authority (`gpt-5.6-sol` and
`gpt-5.6-terra` support everything up to `ultra`). The bridge passes the value
through untouched; `max` and `ultra` reach the session on both the standalone
and the `--remote` path.

Read the effort back from the rollout's `turn_context`, but note the trap: a
freshly spawned session writes **no rollout file until its first prompt is
submitted**. Picking the newest file with `ls -t | head -1` therefore reads some
*other* live session's rollout — which is how a session that really ran at `max`
gets misread as clamped to `high`. Snapshot the directory first, send a prompt,
then diff:

```bash
before=$(mktemp); ls ~/.codex/sessions/*/*/*/*.jsonl | sort > "$before"
TARGET=$($BIN/agent-session.sh --agent codex new "$PWD" mesh-codex-probe \
  -- -c model="gpt-5.6-sol" -c model_reasoning_effort=max)
$BIN/agent-send.sh --agent codex "$TARGET" "Reply with exactly: ok"
comm -13 "$before" <(ls ~/.codex/sessions/*/*/*/*.jsonl | sort) \
  | xargs -r jq -c 'select(.type=="turn_context") | .payload | {model, effort}' \
  | tail -1
```

### Model discovery and pin freshness

`$BIN/mesh-models.sh [--agent codex|claude|--all] [--json] [--refresh]` reports
app-nudged new models, unseen nudges, the desktop-selected model, and the
effective bridge pin. It reports `STALE-PIN` only when a config migration marks
that pin deprecated; otherwise it reports `PIN-STATUS`. It **never auto-bumps a
pin** or writes a harness config: model promotion is a human decision. Discovery
uses each config's read-only `AGENT_MODELS_PROBE_CMD`; Codex reads config signals
best-effort, while Claude reports `no probe available`. Text runs update the
local seen cache; `--refresh` replaces it, and plain `--json` remains read-only.

## Desktop / mobile visibility

Claude bridge sessions start and resume locally by default. Enable Claude Code
Remote Control explicitly only when Claude Desktop or mobile visibility is
needed. A named tmux target is still useful for a readable mesh identity:

```bash
TARGET=$($BIN/agent-session.sh --agent claude new /path/to/project mesh-claude-review)
```

For an existing Desktop-owned conversation, inspect `writer-status --json` and
do not resume it locally. Owned and unknown sessions fail before tmux creation,
preventing a parallel conversation leaf.

Codex bridge sessions use the Codex Desktop app-server path described below.

## Codex Desktop visibility

Codex bridge sessions attach to the desktop **app-server automatically** whenever
its socket is live — they show up inside Codex Desktop and are co-pilotable from
mobile over the remote-control tunnel. No env var to remember.

- `codex.conf` checks the known app-server socket candidates in order and adds
  `--remote unix://…` only for the first candidate that is actually listening; if
  none is live, it prints a warning and falls back to a standalone tmux-only
  session. It also passes `--cd "<dir>"` in remote mode (the app-server ignores
  `tmux -c`, so this keeps the session in the right project).
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
- **No ad hoc cycles.** If A drove B, B must not drive A. The only exception is
  an explicitly user-approved `agent-link.mjs` connection, which is bounded by
  Mesh v1 `seen` and `hop` guards.
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
  `agent-session.sh` confirms the current `Do you trust the contents of this
  directory?` dialog only when its default first option is selected. If stuck,
  check `--status` and capture the pane with `--full`.
- **Claude trust dialog.** Claude 2.1.252+ can start with `No, exit` selected.
  The bridge recognizes only the exact safety prompt, labels, footer, and
  selection marker; it sends `Down`, re-captures the pane, and presses Enter
  only after `Yes, I trust this folder` is visibly selected. Unknown layouts
  terminate the new tmux target and fail closed.
- **Codex app-server socket mismatch.** Without a live `CODEX_REMOTE_SOCK`,
  `codex resume` may try a dead control socket and fail with
  `WebSocket protocol error: Connection reset…`. The auto-detect above resolves
  this when the desktop app-server is up; otherwise `ss -x | grep codex` to find
  a live socket.
- **Queued input survives a kill.** A session killed while it still has queued
  input can execute that input late (observed: a `git commit` fired after the
  session was killed). After killing a session mid-task, verify the real
  side-effect state (`git status` / `git log`) instead of assuming nothing ran.
- **Status flaps between batches.** A multi-phase worker briefly reads `idle`
  between batches; re-check after ~20s before treating `idle` as final, or use
  `agent-wait.sh` (`--poll`/`--stall`) instead of a hand-rolled status loop.
- **Destructive confirmations need the human's key.** A driven agent's
  confirmation prompt for a destructive command (e.g. `rm -rf`) cannot be
  confirmed by orchestrator key relays — safety layers block them by design.
  Have the user attach (writable, no `-r`) and press the key. The bridge
  detects a pending Codex dialog by its tail footer and reports
  `approval-pending` / exit `6` instead of `idle`, so drivers no longer poll
  forever. Two limits: Claude dialogs are not detected yet (no
  `AGENT_APPROVAL_PATTERN` in `claude.conf`), and a prompt whose own text ends
  with the literal footer can trip the pre-send guard — rephrase and resend.
