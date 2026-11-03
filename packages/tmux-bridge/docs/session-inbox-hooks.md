# Owner-bound Claude session inbox

`agent-session-inbox.py hook --agent claude` handles SessionStart,
UserPromptSubmit and Stop. It prepares a private mailbox and starts one detached
`serve` process, not a Bash background task or Monitor. The service lives until
its exact harness/session writer exits; an empty inbox never calls the model.
Bash task completion always notifies Claude, even on an empty timeout, so neither
a larger Bash timeout nor a quiet exit fixes that transport.

The installed hook remains synchronous and bounded to 200 ms (one second in the
hook configuration). Invalid input, unsafe storage, unavailable registrations,
disabled automation and hook failures return silently. The service is detached
with stdin/stdout/stderr disconnected, so hook exit or Bash task timeouts cannot
terminate it or turn its idle periods into task notifications.

## Delivery

The service reads complete `agent-mesh.monitor-inbox.v1` records, batches briefly,
and invokes `claude mcp serve` only for a nonempty batch. This invokes no model.
It resolves the exact session through the live Claude session registration,
checking PID, process start ticks, session ID and owner ancestry. Native
ListAgents must return one matching name and a current disambiguation ref;
SendMessage delivers to that listed address. Ambiguity or refusal leaves the
cursor pending for a silent retry. No terminal injection, second session writer,
credential handling or private Remote Control API is used.

Native enqueue acceptance is not receiver execution or approval. Peer requests
never expand the receiver's mandate. Delivery is at least once: a crash between
native acceptance and cursor persistence can replay the batch. The service keeps
its singleton lock across batches and I/O retries. Readiness requires a live
owner, supervisor and exact receiver identity; detached process ancestry alone
is insufficient for Remote Control children.

## Configuration and privacy

`AGENT_MESH_INBOX_ROOT` / `--root` selects the mailbox root (default
`/var/lib/agent-mesh-mcp/claude-managed-inboxes`). It must be an owner-controlled,
real directory with no group/other write access. Mailboxes, cursors and locks
are private 0600 files. Symlinks, hard-linked state and invalid session IDs are
rejected. Preparation adopts a valid legacy cursor or starts at mailbox EOF;
resuming never resets an existing cursor. Partial records remain pending.

`AGENT_MESH_BIN` overrides binary discovery; otherwise the hook checks the project
skill then `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/agent-tmux/bin`.
`CLAUDE_CONFIG_DIR` also selects native session registrations; `CLAUDE_BIN` selects
the native executable. The hook discovers its owner in process ancestry or uses
`AGENT_MESH_HARNESS_PID` from a trusted launcher. PID reuse and zombies are not
ownership. Set `AGENT_MESH_INBOX_DISABLED=1` (also `true`/`yes`) for automation;
one-shot `claude -p` and Codex activation remain disabled.

## Rollout and compatibility

Install both `skills/agent-tmux` with all its assets and
`hooks/claude-session-start.json` through Agentwheel. Existing sessions must load
the updated hook/settings on a natural event or restart. Existing legacy Bash
watchers can still produce one final timeout notification: do not rearm them.
The Stop/UserPromptSubmit fallback starts the detached service once that legacy
lock is released. Do not interrupt active sessions to accelerate migration.
The explicit legacy `watch` command remains available for existing integrations
and tests; it must never be launched as a Claude background task.

Verify singleton readiness, owner/writer exit, repeated real batch delivery,
unchanged private cursors on failure, and absence of native sends while idle.
The native MCP ListAgents/SendMessage tools and live session registrations are
required; unsupported clients fail closed without discarding mailbox records.
