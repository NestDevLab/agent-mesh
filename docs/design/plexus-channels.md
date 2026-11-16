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

This is not yet a complete channel service: handover completion is not exposed
by the graph command. It has no transport, authorization,
waker integration, recovery procedure or session verification. The caller must not treat the
`verified` argument as evidence by itself. It must establish all of these
properties before connecting the transitions to live sessions.
