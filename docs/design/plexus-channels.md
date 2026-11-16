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
`channel prepare-state` durably reserves a single correlated request before
contacting the current session, then records the validated state digest only if
the same handover, session and generation remain current. Messages may still be
queued while the request runs. A failure or lost response leaves the request
unresolved and prevents an automatic resend; recovery is not yet implemented.
The proof does not authorize cutover, archive, or final-message publication.

`trigger-transaction.mjs` supplies a generic transaction engine, not a live
scheduler adapter. Its injected journal must atomically reserve overlapping
trigger sets and durably record intent before each move. Its adapter must
compare the original target and a never-reused state version atomically and
expose the operation ID on readback. Definite refusal rolls back earlier verified moves using the same
compare-and-set contract; an ambiguous result stays unresolved and is not
retried. Dry-run reads and journals a plan without moving triggers. Concrete
timer and cloud adapters are not yet provided; this
engine is not authorization to change live triggers.

`trigger-journal.mjs` implements the local journal in an explicitly selected,
private canonical directory. It reserves overlapping trigger sets atomically,
persists snapshots using fsync and atomic replacement, and rejects reused
transaction IDs. Uncertain transactions keep their reservation after restart.
A leftover lock requires operator reconciliation; it is never removed as stale
automatically. The journal is a trusted local operator component and does not
itself prove a scheduler change. Explicit recovery of an `uncertain` receipt
first inspects every trigger and rolls back only versions linked to the original
operation; other changes remain unresolved. A recovery lock prevents concurrent
recovery. Abrupt process loss while an operation is still `applying` or
`rolling-back`, or an abandoned lock, requires separate operator reconciliation.
The prepared Codex path additionally requires a fresh unarchived native-thread
observation and exactly one detected writer. Claude and cloud successors are
not yet supported by this operation.

`cloud-account-binding.mjs` prepares an opt-in Claude CLI account check. A
private operator profile binds an account scope to a CLI configuration directory
and a digest of its reported account and organization; the helper checks the
same profile before and after an operation and treats changes as uncertain.
Profile configuration and digests are private. This check relies on a trusted
CLI and configuration directory, does not prevent a concurrent credential
switch, and is not provider readback or proof of delivery. It is not connected
to channel routing or enabled by default.

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
# Role-scoped restart preparation

The `agent-mesh.restart.v1` YAML handover block requires `role_profile` when
used as a state proof. Its schema `agent-mesh.role-profile.v1` contains `role`
and unique identifier arrays `permissions`, `mcp`, and `plugins`. These are
references, not commands or grants. A trusted private authority must resolve
them and reject out-of-scope or human-gated permissions. A missing profile
fails handover preparation; legacy readers may still parse old state.

The isolated role-launch planner probes only the configured MCP names. An
unreachable MCP is omitted and listed in the receipt without blocking startup.
The launch assessor reports the observed MCP count and startup tokens, or null
when tokens are unavailable; an unexpected permission prompt or component
requires rollback. These are preparation primitives only: no provider startup,
permission enforcement, timeout cancellation, live rollback or token collector
is connected yet. The approved handover remains disabled until native evidence
and those adapters are present.
