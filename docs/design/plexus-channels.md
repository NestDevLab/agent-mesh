# Channel transition prototype

The public [architecture diagram](plexus-architecture.mmd) distinguishes
implemented components from planned links. Keep its source in
`scripts/plexus-diagram.mjs` synchronized; the readiness check compares them.

`channel-state.mjs` defines pure JSON transitions for a stable channel, its
current session and a queue. An in-flight message is bound to a session and
generation. A handover stops new dispatch and cannot finish while a delivery is
unresolved. Only a matching acceptance receipt resolves an in-flight message.

The graph command now persists channel creation, enqueue and handover start as
events under the graph writer lock. Queued messages survive replay and
compaction. The graph and event log contain message bodies and must remain
private; this is not a scoped remote API.

The graph command can also reserve a pending message and record a matching
acceptance receipt. Reservation is durable before transport; a crash or
uncertain outcome leaves the item in flight and blocks handover. A local
caller is responsible for verifying transport receipts before recording them.

Handover completion currently supports only a Codex successor with a fresh
unarchived native-thread observation and exactly one detected writer. It
atomically changes the channel and emits `session.handover`, with a native
thread link in the channel receipt. Missing or ambiguous evidence fails closed;
Claude and cloud successors are not yet supported by this operation.

This is not yet a complete handover workflow: it does not write state for the
old session, publish or verify the old session's final notice, archive anything,
or reconcile uncertain transport outcomes. It must not be used for a live
handover until those steps and their failure recovery are implemented and
verified. The local graph is a trusted operator interface, not a remote API.
