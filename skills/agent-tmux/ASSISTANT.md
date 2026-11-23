# Agent tmux Bridge — Assistant Quick Reference

Agent-agnostic: swap `--agent codex` ↔ `--agent claude`. Same scripts drive
either type, same-type included.

```bash
BIN="$AGENT_MESH_ROOT/packages/tmux-bridge/bin"
POLICY="${XDG_CONFIG_HOME:-$HOME/.config}/limen/codex-shadow-policy-v2.json"

# New / resume (prints tmux target)
# New work declares a capability profile. Limen selects the native provider.
TARGET=$($BIN/agent-spawn.sh --profile "$ROLE" --limen-config "$POLICY" new /path/to/project)
TARGET=$($BIN/agent-session.sh --agent claude resume <SESSION_ID>)

# New Codex session with a readable Codex Desktop title
TARGET=$($BIN/agent-session.sh --agent codex --title "agent-mesh: review" new /path/to/project)

# Extra agent flags after `--` (e.g. Codex xhigh) — no need to bypass the bridge
$BIN/agent-spawn.sh --profile "$ROLE" --limen-config "$POLICY" new "$DIR"

# Send prompt, get reply
$BIN/agent-send.sh --agent codex "$TARGET" "your prompt" [timeout]

# Delegate with source identity + optional return coordinates
$BIN/mesh-send.sh --to codex --from claude-reviewer --from-agent claude --from-target mesh-claude-reviewer "your prompt" 300

# Session graph
$BIN/mesh-graph.mjs show --compact
$BIN/agent-session.sh --agent codex inspect <SESSION_ID> --json --graph-target mesh-codex-main
# Launch provenance (append-only; thread resolution is exact or ambiguous).
python3 "$BIN/bridge-launch-record.py" \
  --state "${XDG_STATE_HOME:-$HOME/.local/state}/agent-mesh/launches/events.jsonl" \
  show --target <TMUX_TARGET>
# Read-only sweep of persisted transcripts; discovered sessions stay unclassified.
$BIN/mesh-graph.mjs discover --agent codex --quiet-after 3600 --json
# Reconcile persisted sessions and live tmux targets; missing targets become quiet, never closed.
MESH_TMUX_SOCKET=mesh $BIN/mesh-graph.mjs sweep --quiet-after 3600 --json
# Explicit, transcript-only Desktop adoption; set the compact summary separately.
$BIN/mesh-graph.mjs adopt --agent codex --runtime-uuid <SESSION_UUID>
$BIN/mesh-graph.mjs summary --id <NODE_ID> --summary "one compact label"
$BIN/mesh-graph.mjs ref add --id <NODE_ID> --ref source:opaque-id
$BIN/mesh-graph.mjs ref remove --runtime-uuid <SESSION_UUID> --ref source:opaque-id

# Status / wait
$BIN/agent-read.sh --agent codex "$TARGET" --status        # idle | working | error
$BIN/agent-wait.sh --agent codex "$TARGET" --timeout 300 --stall 180

# Read-only transcript cursor (works without a tmux target)
python3 "$BIN/agent-watch.py" <SESSION_ID> --agent codex --state /path/to/cursor.json --init
python3 "$BIN/agent-watch.py" <SESSION_ID> --agent codex --state /path/to/cursor.json --drain --format jsonl

# User-approved bounded connection (run once with --init, then without it)
$BIN/agent-link.mjs --mode bidirectional --state /path/to/link-state.json \
  --left-agent codex --left-session <ID> --left-target <TMUX> \
  --right-agent claude --right-session <ID> --right-target <TMUX> --init

# Discover all agents + live sessions
$BIN/mesh-list-agents.sh

# An explicitly requested model and effort may narrow the profile.
$BIN/agent-spawn.sh --profile "$ROLE" --model "$MODEL" --effort "$EFFORT" \
  --limen-config "$POLICY" new "$PWD"
```

## Decision tree

1. Codex Desktop task tools exposed and both endpoints are Desktop tasks → use
   `send_message_to_thread`, `wait_threads` / `read_thread`, `create_thread`, or
   `fork_thread` as appropriate
2. Session ID given for persistent CLI control →
   `agent-session.sh --agent <type> resume <ID>`
3. Native task control unavailable or an MCP reply tool returns "Session not
   found" → fall back here and state why
4. Fresh persistent CLI session needed →
   `agent-spawn.sh --profile "$ROLE" --limen-config "$POLICY" new "$CWD"`
5. Talk to an already-running mesh agent → `mesh-send.sh --to <name>`

## Important

- Always use `agent-send.sh` — it handles the per-agent submit key (`C-m` for
  Codex, `Enter` for Claude) and reconnection polling. Never `tmux send-keys …
  Enter` directly.
- Native Codex Desktop tasks are user-visible peers. Create one only after an
  explicit user request; use native subagents for hidden same-turn worker fan-out.
- Governed Codex starts use the local native subscription. Existing Desktop sessions keep their own native delivery path.
- For Codex Desktop title hygiene, pass `--title "<short title>"` to
  `agent-session.sh ... new`; it is prepended once to the first real prompt.
- Timeouts are checkpoints: `progress` = pane changed recently, `stalled` = it
  did not. Inspect and decide; ask before stopping another agent.
- Return-path coordinates are informational — use only when the user explicitly
  asks to message the source back.

## Anti-recursion & fan-out safety

- **Default depth 1**: you drive workers; workers don't spawn more agents unless
  the user asked for multi-level orchestration.
- **No ad hoc cycles**: only a user-approved `agent-link.mjs` connection may
  return `A -> B -> A`, bounded by Mesh v1 hop/seen guards.
- **Reuse before spawning**: check `mesh-list-agents.sh`; don't pile up duplicate
  sessions.
- **Name children to show nesting**; pass `--from` for provenance.
- **Approvals are transitive**: a spawned agent that commits/pushes/deploys/sends
  is still bound by the user's git/safety rules — pass them down explicitly.
- An exact model and effort pair narrows an eligible profile. Start only with an enforced lease. On defer, inspect the reasons and retry time before rescheduling.
