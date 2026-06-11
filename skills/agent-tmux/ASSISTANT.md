# Agent tmux Bridge — Assistant Quick Reference

Agent-agnostic: swap `--agent codex` ↔ `--agent claude`. Same scripts drive
either type, same-type included.

```bash
BIN="$AGENT_MESH_ROOT/packages/tmux-bridge/bin"

# New / resume (prints tmux target)
TARGET=$($BIN/agent-session.sh --agent codex  new /path/to/project)
TARGET=$($BIN/agent-session.sh --agent claude resume <SESSION_ID>)

# Extra agent flags after `--` (e.g. Codex xhigh) — no need to bypass the bridge
$BIN/agent-session.sh --agent codex new "$DIR" mesh-codex-b1 -- -c model_reasoning_effort=xhigh

# Send prompt, get reply
$BIN/agent-send.sh --agent codex "$TARGET" "your prompt" [timeout]

# Delegate with source identity + optional return coordinates
$BIN/mesh-send.sh --to codex --from claude-reviewer --from-agent claude --from-target mesh-claude-reviewer "your prompt" 300

# Status / wait
$BIN/agent-read.sh --agent codex "$TARGET" --status        # idle | working | error
$BIN/agent-wait.sh --agent codex "$TARGET" --timeout 300 --stall 180

# Discover all agents + live sessions
$BIN/mesh-list-agents.sh
```

## Decision tree

1. Session ID given → `agent-session.sh --agent <type> resume <ID>`
2. MCP reply tool returns "Session not found" → fall back here
3. Fresh session needed → `agent-session.sh --agent <type> new <dir>`
4. Talk to an already-running agent → `mesh-send.sh --to <name>`

## Important

- Always use `agent-send.sh` — it handles the per-agent submit key (`C-m` for
  Codex, `Enter` for Claude) and reconnection polling. Never `tmux send-keys …
  Enter` directly.
- Codex sessions auto-attach to the desktop app-server when its socket is live
  (visible in Codex Desktop / mobile). `CODEX_NO_REMOTE=1` forces standalone.
- Timeouts are checkpoints: `progress` = pane changed recently, `stalled` = it
  did not. Inspect and decide; ask before stopping another agent.
- Return-path coordinates are informational — use only when the user explicitly
  asks to message the source back.

## Anti-recursion & fan-out safety

- **Default depth 1**: you drive workers; workers don't spawn more agents unless
  the user asked for multi-level orchestration.
- **No cycles**: if A drove B, B must not drive A.
- **Reuse before spawning**: check `mesh-list-agents.sh`; don't pile up duplicate
  sessions.
- **Name children to show nesting**; pass `--from` for provenance.
- **Approvals are transitive**: a spawned agent that commits/pushes/deploys/sends
  is still bound by the user's git/safety rules — pass them down explicitly.
