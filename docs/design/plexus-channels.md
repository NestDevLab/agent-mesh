# Channel transition prototype

The public [architecture diagram](plexus-architecture.mmd) distinguishes
implemented components from planned links. Keep its source in
`scripts/plexus-diagram.mjs` synchronized; the readiness check compares them.

`channel-state.mjs` defines pure JSON transitions for a stable channel, its
current session and a queue. An in-flight message is bound to a session and
generation. A handover stops new dispatch and cannot finish while a delivery is
unresolved. Only a matching acceptance receipt resolves an in-flight message.
Channel identifiers may start with `#`; the prefix is part of the identifier.

The graph command now persists channel creation, enqueue and handover start as
events under the graph writer lock. Queued messages survive replay and
compaction. The graph and event log contain message bodies and must remain
private; this is not a scoped remote API.
Channel operations reject a non-private or non-canonical graph directory and
reject existing graph, checkpoint, snapshot or event files with unsafe owner,
permissions, links or file type. They do not silently repair existing state.

The graph command can also reserve a pending message and record a matching
acceptance receipt. Reservation is durable before transport; a crash or
uncertain outcome leaves the item in flight and blocks handover. A local
caller is responsible for verifying transport receipts before recording them.

Handover completion is disabled until an adapter can verify that the old
session wrote its state. A path or caller assertion is not sufficient proof.
`handover-state-proof.mjs` prepares the file-verification part: it binds a
correlated actor response to a session, nonce, filename and SHA-256, and checks
the private file without following a final symlink. `requestStateProof` obtains
the response through the existing native correlated-result transport; Codex
resume remains disabled. The verifier decodes and validates the restart block,
but does not reconcile its triggers or make a graph cutover.
The prepared Codex path additionally requires a fresh unarchived native-thread
observation and exactly one detected writer. Claude and cloud successors are
not yet supported by this operation.

This is not yet a complete handover workflow: it does not write state for the
old session, publish or verify the old session's final notice, archive anything,
or reconcile uncertain transport outcomes. It must not be used for a live
handover until those steps and their failure recovery are implemented and
verified. The local graph is a trusted operator interface, not a remote API.

`handover-notice.mjs` builds a notice from already resolved identifiers. It
supports same-project cloud anchors, cross-project cloud URLs and Codex thread
URLs. Its transcript comparison is only a predicate: an authenticated adapter
must independently supply a complete observation and prove the successor's
identity. Formatting or matching caller-supplied data alone is not evidence of
publication, finality or authorization to archive.

`handover-codex-observation.mjs` can inspect a bounded local Codex transcript
snapshot for a correlated request followed by the exact final notice and a
matching completed turn. It fails closed for ambiguous files, malformed or
partial records, and identity mismatches. It returns hashes, never transcript
contents. This observation is local evidence at the instant read, not proof
that no later turn can arrive; safe finality still requires exclusive lifecycle
control and an authenticated source. Claude and cloud transcripts are not
supported by this observer.
