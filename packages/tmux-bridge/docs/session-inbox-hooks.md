# Automatic session inbox activation

`bin/agent-session-inbox.py hook --agent claude|codex` accepts a SessionStart
payload on stdin. It creates or reopens `<session_id>.jsonl` without truncation,
enforces mode 0600, and returns `hookSpecificOutput.additionalContext` instructing
the session to start a silent background reader. Invalid input or unavailable
storage fails open, with a short diagnostic on stderr and no readiness claim.
The hook never starts another model, resumes a second writer, or sends a message.

The default mailbox root is `/var/lib/agent-mesh-mcp/claude-managed-inboxes`.
Deployments can set `AGENT_MESH_INBOX_ROOT` or pass `--root`. The installer must
provision this directory for the harness user and align the native-call managed
inbox root. Mailboxes and cursors are private runtime state; never commit them.

## Hook configuration

The source fragments `hooks/claude-session-start.json` and
`hooks/codex-session-start.json` cover startup, resume, clear and compact. Merge
the appropriate fragment into the harness's existing hooks through its managed
configuration; preserve all other hook handlers. Set `AGENT_MESH_BIN` to the
installed bridge binaries directory in that execution environment. The new
Python binary is included by the package's existing `*.py` skill assets rule;
the hook fragments must be wired separately by the deployment configuration.
No installer or live harness configuration is changed by these sources.

Claude Code supports SessionStart context injection and Bash background tasks.
The context explicitly uses `Bash` with `run_in_background=true`, never Monitor.
See the [Claude hook reference](https://code.claude.com/docs/en/hooks).

Codex also supports SessionStart, including startup and resume matchers and
`additionalContext`, as described in the [official hook reference](https://learn.chatgpt.com/docs/hooks).
The local verification used CLI 0.163.0, where `codex features list` reports
`hooks stable true`. Non-managed hook definitions require harness trust review;
managed policy can restrict which hooks run. This support does not prove that
every Codex surface provides asynchronous shell completion notifications. The
Codex context requests its native background tool, and explicitly forbids
claiming automatic reachability if that capability is unavailable. Native Codex
queue delivery remains the existing transport; this change does not replace it
or require the desktop application. A deployment must verify hook firing and
background notification delivery for its actual harness before marking it ready.

## Reader lifecycle

The background command is `agent-session-inbox.py watch --session <id>` with
the same root. An advisory lock permits one supervisor per session; a duplicate
invocation exits silently. The supervisor restarts the existing inbox reader
after failure or expiry, discards non-event output, and returns only valid
`AGENT_MESH_INBOX` records. It batches briefly after the first event and then
exits. The injected context tells the session to handle the batch and immediately
rearm the same background command. It emits no idle or restart notifications.
The cursor survives resume and suppresses replay of already consumed records.
Termination signals stop the supervisor and reader for harness shutdown.

Writer readiness continues to require exactly one known Claude writer and
exactly one inbox reader. Both CLI and desktop writers are accepted, while
incomplete discovery and multiple writers remain blockers. A prepared mailbox
alone is never evidence that a session can receive messages.

## Deployment acceptance

After source merge, the fleet delivery must provision mailbox ownership,
materialize binaries, merge the hook fragments and perform required trust review.
Verify a fresh and a resumed CLI session, mode 0600, one reader after repeated
activation, no idle notifications, recovery after reader termination, and an
authorized correlated inbox event. Separately verify Codex native queue delivery
and the deployed background notification surface. No live install or canary is
performed by the repository tests.
