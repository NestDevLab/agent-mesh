# Blank Codex session ownership

Creation resolves the native thread from the exact new unattended pane and its
writer lock, including its authorized cwd. It does not require a seed model turn
or a persisted thread row. The gateway retains a process-local capability binding
the thread to its workspace, cwd, pane, writer and creation socket. Every owned
get/send checks the bound thread's writer and exact pane, including the writer's
cwd, on the original socket. Unique-candidate discovery is used only at creation;
attached observers and other threads started by the session do not invalidate the
bound identity. Creation failures kill the new target only before its ID has
been returned to the caller.

After creation, get, transcript and send never kill the target. Inconclusive
proof (including timeouts, races and incomplete observations) fails that call
with a retryable error and retains the capability. Proven thread, writer, pane or
cwd changes revoke the capability and refuse later calls without resume or
native-call fallback, leaving the process alone. A turn timeout, no output,
parsing failure or other send/result error does not revoke ownership. In
particular, result_timeout is returned while the turn may still be progressing;
later get and transcript remain available.

Before persistence, get returns authorized launch metadata and transcript returns
an empty page if the bridge has no transcript yet. Persisted metadata is used
when available. Another workspace cannot use this launch capability, even when
its roots overlap. A guessed unpersisted ID has no capability. After a gateway
restart, a still-unpersisted session fails closed with an explicit error; create
a new session instead of trying to reconstruct ownership.

Owned sends use the original pane and socket, including the trusted full-access
socket. They never resume the thread or use the native-call path. Access-profile,
trusted-socket and per-principal tool authorization remain prerequisites.

This change requires a new gateway release. A config-only install is insufficient.
No rollout or live-service restart is part of this change.
