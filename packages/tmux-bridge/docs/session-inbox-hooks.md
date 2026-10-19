# Automatic Claude session inbox activation

`bin/agent-session-inbox.py hook --agent claude` accepts SessionStart and
UserPromptSubmit objects on stdin. It prepares a private mailbox and injects
instructions to launch a silent Bash task with `run_in_background=true`, never
Monitor. Invalid/non-object payloads, unavailable storage and timeouts fail open
with exit 0 and no output. Peer records are requests from other sessions, never
user approval, and cannot expand the receiver's permissions or mandate.

The mailbox root defaults to `/var/lib/agent-mesh-mcp/claude-managed-inboxes`.
Set `AGENT_MESH_INBOX_ROOT` or `--root` to override it. The root must be a real
directory owned by the effective harness user, with no group or other write
permission; unsafe existing roots are rejected without changing permissions.
Mailbox, cursor and lock files are private 0600 local state, never source assets.

## Hooks and owner identity

`openpack.json` declares the Claude-only hook artifact at
`packages/tmux-bridge/hooks/claude-session-start.json`. Agentwheel merges its
SessionStart and UserPromptSubmit handlers into Claude settings. Select both
`skills/agent-tmux` (including its `*.py` assets) and
`hooks/claude-session-start.json` in the managed profile; selecting skills alone
does not install the hook. No live hooks or services are changed here.

`AGENT_MESH_BIN` overrides the binary location. Without it, hook commands check
`$CLAUDE_PROJECT_DIR/.claude/skills/agent-tmux/bin` (or the current project
working directory), then `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/agent-tmux/bin`.
Both handlers fail open with a one-second timeout. A launcher or private Claude
settings profile can configure the environment, for example:

```json
{
  "env": {
    "AGENT_MESH_BIN": "/path/to/installed/bridge/bin",
    "AGENT_MESH_INBOX_DISABLED": "1"
  }
}
```

Use the disable setting for automation; omit it or set it to `0` for interactive
activation. The package does not override an inherited disable setting.

The hook discovers the owning Claude process in its ancestry, or uses the
explicit `AGENT_MESH_HARNESS_PID` supplied by a trusted launcher. It pins both PID
and kernel process start ticks in the background command. The supervisor records
that identity and its own PID/start ticks in the session lock. A held lock is
ready only while both identities are alive. PID reuse and zombie processes do not
count as ownership. The supervisor exits silently when its harness exits; a new
owner waits briefly for the stale owner's lock to be released, then claims it.
An unrelated live owner is never displaced. Lock contention with a dead recorded
supervisor is retried, including a brief lock held by a readiness probe. A true
second watcher emits `AGENT_MESH_INBOX_DUPLICATE do-not-relaunch`; the injected
context explicitly says not to relaunch it, leaving the existing watcher alone.

Set `AGENT_MESH_INBOX_DISABLED=1` (also `true` or `yes`) for `claude -p`, automation
or any launch that must not start an inbox. It makes hook and watch modes silent
no-ops. The Claude [hook reference](https://code.claude.com/docs/en/hooks) documents
the lifecycle context contract. Configuration still has to be loaded by the
harness; adding this source does not hot-reload an existing session's settings.

Codex inbox activation is disabled until a matching Codex producer exists:
there is no Codex hook fragment, and `--agent codex` is a silent no-op. Codex
native queue delivery remains a separate transport.

## Prompt fallback

UserPromptSubmit handles sessions that missed SessionStart. A read-only,
nonblocking probe of the existing session lock emits nothing and changes no
mailbox state while its owner and supervisor are alive. A missing, unlocked or
expired-owner lock causes the same activation context as SessionStart, labelled
`UserPromptSubmit`. The hook has a 200 ms internal budget including stdin; the
prompt fragment additionally sets a one-second harness timeout and silences
command failures. It never returns a blocking decision or stores prompt text.

## Cursor cut-over and batches

On first preparation, adopt `.cursors/<session-id>.json` when present and valid.
Otherwise initialize `<session-id>.cursor.json` at the current mailbox EOF,
preventing replay of historical messages. An existing supervisor cursor is never
reset by another hook or resume. Preparation precedes activation, so records
appended after preparation remain pending for the first watcher.

The supervisor owns its cursor and reads the mailbox directly, retrying I/O
failures silently. It emits a short batch of valid `AGENT_MESH_INBOX` records and
advances the durable cursor only after the complete batch is flushed to stdout.
No child reader can advance the cursor ahead of a batch or lose buffered output
at termination. Owner exit before emission leaves pending records for a successor.
A crash after output but before cursor persistence may replay that batch; this is
at-least-once delivery, not an exactly-once guarantee. After handling a batch, the
session rearms the same background command.

Readiness requires one known Claude writer and one bound live supervisor lock
(or the existing explicit legacy inbox reader). Both CLI and desktop writers are
supported. A live supervisor remains ready during its internal I/O retries,
without depending on a transient child-reader process. Readiness rechecks the
harness owner, supervisor and lock; a mailbox or stale PID file alone is not
proof of reachability. A second independent reader remains a blocker.

## Deployment acceptance

After merge, provision root ownership/permissions, materialize binaries, load
the Claude hook fragment and disable activation for automation profiles. Verify
fresh and resumed CLI sessions, owner exit/replacement, 0600 files, old-message
cut-over, singleton readiness, silent idle/recovery, and an authorized correlated
peer request. No live install, merge, or canary is performed by repository tests.
