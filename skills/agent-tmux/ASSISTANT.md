# Agent tmux Bridge — Assistant Quick Reference

Agent-agnostic: swap `--agent codex` ↔ `--agent claude`. Same scripts drive
either type, same-type included.

```bash
BIN="$AGENT_MESH_ROOT/packages/tmux-bridge/bin"
POLICY="${XDG_CONFIG_HOME:-$HOME/.config}/limen/codex-shadow-policy-v2.json"

# New / resume (prints tmux target)
TARGET=$($BIN/agent-session.sh --agent codex  new /path/to/project)
TARGET=$($BIN/agent-session.sh --agent claude resume <SESSION_ID>)

# New Codex session with a readable Codex Desktop title
TARGET=$($BIN/agent-session.sh --agent codex --title "agent-mesh: review" new /path/to/project)

# Extra agent flags after `--` (e.g. Codex xhigh) — no need to bypass the bridge
$BIN/agent-session.sh --agent codex new "$DIR" mesh-codex-b1 -- -c model_reasoning_effort=xhigh

# Send prompt, get reply
$BIN/agent-send.sh --agent codex "$TARGET" "your prompt" [timeout]

# Delegate with source identity + optional return coordinates
$BIN/mesh-send.sh --to codex --from claude-reviewer --from-agent claude --from-target mesh-claude-reviewer "your prompt" 300

# Session graph
$BIN/mesh-graph.mjs show --compact
$BIN/agent-session.sh --agent codex inspect <SESSION_ID> --json --graph-target mesh-codex-main

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

# Governed persistent session: choose exactly one routing form.
$BIN/agent-spawn.sh --agent codex --profile developer --limen-config "$POLICY" new "$PWD"
$BIN/agent-spawn.sh --agent codex --model gpt-5.6-terra --effort high \
  --limen-config "$POLICY" new "$PWD"

# Optional bounded override: exact pair only, and only after a soft capacity defer.
$BIN/agent-spawn.sh --agent codex --model gpt-5.6-terra --effort high \
  --limen-config "$POLICY" --force new "$PWD"
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
   `agent-session.sh --agent <type> new <dir>`
5. Talk to an already-running mesh agent → `mesh-send.sh --to <name>`

## Important

- Always use `agent-send.sh` — it handles the per-agent submit key (`C-m` for
  Codex, `Enter` for Claude) and reconnection polling. Never `tmux send-keys …
  Enter` directly.
- Native Codex Desktop tasks are user-visible peers. Create one only after an
  explicit user request; use native subagents for hidden same-turn worker fan-out.
- Codex sessions auto-attach to the desktop app-server when its socket is live
  (visible in Codex Desktop / mobile). `CODEX_NO_REMOTE=1` forces standalone.
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
- A partial `--model`/`--effort` pair or mixing it with `--profile` is rejected.
  A normal Limen defer waits; `--force` can only create an explicitly unleased
  exact session after a soft capacity defer, with no lease renewal/completion.
