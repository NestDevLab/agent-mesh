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
retried. A failed preflight read records a terminal not-applied receipt before
releasing its reservation; no trigger move has been attempted. Dry-run reads
and journals a plan without moving triggers. Concrete
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
The native cloud transport can opt into this binding with an explicitly scoped,
private `agent-mesh.cloud-account.v1` profile. The queued comms replay binds the
profile digest and scope, refusing a changed profile. Its provider acknowledgement
still proves queue acceptance only; it does not prove that the recipient read it.
The channel waker can opt in with a private profile directory; it routes a scoped
cloud session once and keeps the message in flight until independently verified.
There is no cloud readback reconciliation yet, so this route is not operational
for handover and deliberately blocks subsequent delivery. Account checks
cannot exclude a non-cooperating concurrent switch that is changed and restored
between the checks; the profile and account directory require operator control.
Profile configuration and digests are private. This check relies on a trusted
CLI and configuration directory, does not prevent a concurrent credential
switch, and is not provider readback or proof of delivery. The route is disabled
by default.

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
control and an authenticated source.

`handover-claude-observation.mjs` performs a comparable local Claude snapshot
check bound to session, request nonce, exact notice and completed turn. It
rejects later user turns and tool calls. Both observers return evidence only;
neither sends a message, proves remote cloud delivery, or enables a cutover.

`handover-notice-transport.mjs` can enqueue a correlated final-notice request
through the existing local native transport and independently inspect the
resulting local transcript. Queue acceptance is not publication proof. The
caller must first durably reserve the request, verify the successor, and hold
exclusive lifecycle control; a failed or held enqueue must not be retried
blindly. These prerequisites are not yet connected, and this adapter is not
wired to cutover or cloud delivery. A graph `channel reserve-notice` transition
requires verified state and a freshly verified Codex successor, binds the
notice digest and nonce, and survives replay. The adapter can bind an enqueue
to that reservation. `channel observe-notice` records a matching local
transcript snapshot against the reservation, but does not acquire lifecycle
exclusion or establish that a later turn cannot occur. The actual cutover
remains disabled.
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
permission enforcement, live rollback or token collector is connected yet. The approved handover remains disabled until native evidence
and those adapters are present.

`handover-dry-run.mjs` rehearses only in memory; it never contacts native
sessions, MCPs or timers. Its synthetic fault tests cover two roles, offline MCP,
permission prompt, interrupted start, quota exhaustion and a queued message.
It does not verify native delivery, rollback or the real pilot.

An optional stdio probe resolves MCP names exclusively through a trusted
operator-supplied allowlist and launches without a shell. On Linux the probe
uses bubblewrap with a separate PID namespace and a strict stdin gate; it checks
the namespace init owner, parent and namespace identity before releasing the
command. The gate requires an explicit permit and rejects EOF or partial input;
a missing gate acknowledgement is a containment error, not an offline result.
It requires an MCP initialization response and ping, bounds output and time,
then terminates the owned process group and waits for wrapper closure. Missing
or unverified containment stops planning instead of classifying the MCP offline.
A synthetic detached-child test checks for a delayed local effect after closure.
This is not a security boundary: the authorized command retains its configured
filesystem and network access, and remote effects and all runtime environments
remain unverified. It supports protocol `2024-11-05` only; a successful probe
does not prove that an MCP started in the successor. It is not scheduled or
wired to live handover. Other probes must honor cancellation themselves; an
unconfirmed cancellation stops the plan.

`codex-mcp-observation.mjs` prepares an opt-in, bounded app-server connection
sample for a requested thread. It discards server names and endpoint data, fails
on ambiguous pagination, and reports an observed connection count separately
from the unknown number of processes started and unknown startup tokens. Its
profile and generation bindings are caller claims, the server does not echo the
thread identifier in each page, and pagination is not atomic. An isolated Codex CLI 0.169.0 experiment showed that listing after the
fixture MCP process was stopped restarted it; a control without listing did
not restart it during the observation window. This is an active discovery
operation, not a read-only health check. There is no default live connector; do
not call it on a live thread or treat it as launch evidence. Unit tests use
only a synthetic app-server callback.

`codex-mcp-startup-notifications.mjs` can accumulate the app-server's native
startup notifications on an already established connection without issuing an
inventory request. In an isolated Codex CLI 0.169.0 experiment, a synthetic
thread emitted `starting` and `ready` notifications bound to that thread. The
observer keeps names only in memory, bounds its buffer and reports only counts;
its completeness is unverified and it never claims a process-start or token
count. Integration must attach before the authorized isolated startup, bind the
actual thread response, and independently establish session, profile and event
coverage before using the result as a receipt. It is not enabled for live use.

`codex-role-mcp-overrides.mjs` prepares explicit disabled entries for servers
outside a role launch plan from a supplied effective inventory, without copying
server commands or enabling a previously disabled server. In isolated Codex CLI
0.169.0 experiments, an empty `mcp_servers` override inherited both configured
fixture servers, while an explicit disabled entry suppressed the excluded
fixture. The generated override produced the same result in that fixture. This
is not proof of complete isolation: the inventory may change or omit dynamic
plugin servers, and permissions and plugins require independent enforcement.
No live launch is wired to this planner.

`codex-role-start-assessment.mjs` compares the complete native permission
profile and sandbox objects against a trusted expected policy and flags observed
approval or elicitation requests for rollback, including the legacy Codex
approval requests identified by conversation ID. It does not perform rollback or
prove that no prompt was missed. A matching response remains incomplete while
plugin isolation, MCP event coverage and startup token evidence are unknown.
The Codex CLI 0.169.0 generated schema says its `disabledPluginIds` response
field does not yet filter plugin capabilities; it must not be treated as proof
that excluded plugins are inactive. No live launch uses this assessment.

`namespace-exec-gate.py` is a coordination gate for a future dedicated
launcher: it executes only after an explicit `GO` record on an owner-private
FIFO and fails closed on EOF, a different record or an unsafe FIFO. It does not
authenticate a same-user writer, establish process ownership, or implement
rollback. Isolated tests covered coordinator exit and a child that changes
process group inside a PID namespace; production launcher ownership, pidfd
recovery, runtime compatibility and remote effects remain unverified. The gate
is not connected to live handover.

`isolated-pid-namespace.py` prepares a network-isolated experimental child
behind that gate. It checks the namespace init's parent, owner, namespace ID
and pidfd identity before opening the gate. Its stop operation targets only
the pinned init and reports local init exit with descendant and remote effects
still unverified. Preparation failure closes the gate without releasing it; if
ownership or cleanup cannot be established it reports uncertainty. The lease
must remain in the creating process and is not a persistent recovery mechanism,
an authorization boundary or an integrated live session launcher. Isolated
tests cover abrupt supervisor exit both before and after release, including a
child that changes process group; neither case proves behavior for external
services or other runtime configurations. The sandbox uses a read-only host
filesystem with a private writable workspace and is for isolated fixtures only.

The optional `codex-native-rollback.integration.py` exercise accepts an absolute
Codex executable through `AGENT_MESH_TEST_CODEX_BIN`. It creates only temporary
state, two dedicated network-isolated app servers and synthetic MCP/provider
processes. A synthetic interactive approval request causes the test supervisor
to stop the successor namespace, then check that the predecessor accepts a new
turn. This does not wire rollback into handover, prove remote cleanup or permit
interactive approvals in a live role. Without the variable the test reports a
skip; an unavailable or incompatible runtime with the variable set is a failure.

`isolated-role-rollback.py` connects a caller-bound Codex role assessment to
one stop of a caller-owned isolated successor. An incomplete assessment blocks
handover without stopping; an unsafe one reserves a session-keyed intent in an
owned private journal and syncs it before the stop callback. A second coordinator
using that same journal refuses to retry after a crash or uncertain response;
results are recorded separately. Even a confirmed namespace init exit leaves
descendant and remote effects unverified and handover blocked. The caller must
use a stable journal root, authenticate the assessment and bind it to the correct
native connection and namespace lease; this primitive does not establish those
facts, move a channel, or provide a live rollback controller.

The pure handover model separates switching to a successor from observing the
messages queued before the switch, then reserving the final notice for the
predecessor. Provider queue acceptance is not recipient observation. The
observation argument is a host-supplied contract, not an authenticated adapter;
no graph operation accepts it or enables live cutover. The rehearsal stops at
the switched-and-awaiting-delivery phase and cannot prove notice finality.

A new Codex wake proof binds the native queued payload to the channel,
generation, queue ID and correlation before starting it, then reads back the
exact native message. When this proof is verified and settled in a draining
channel, it marks that backlog message observed. Older proof schemas remain
valid wake evidence but cannot establish this stronger delivery binding.
If a native start outcome is uncertain, readback-only recovery is disabled: a
steered message can match while the submission remains queued. Recovery evidence
schemas v3 and v4 with the correlated-recovery source are rejected. Reservations
remain unresolved until an independently verified consumption source exists.
This is not a cloud or Claude delivery adapter; native cutover remains disabled.

For a draining local Claude channel, `observe-claude-delivery` checks one
managed inbox record in a stable local user transcript snapshot, binding its
correlation, payload, session and generation before marking the backlog item
observed. It requires a unique matching native enqueue preceding the user
record; an enqueue-only record is insufficient. Native inbox user records can
carry the `isMeta` flag and remain eligible when this correlation is proven. This source does not prove
execution, attention, finality or cloud delivery; its real transport transcript
shape still requires isolated qualification. Operational cutover remains disabled.

A previously verified restart-state receipt can be revalidated against the
current private file before a future cutover. Revalidation checks generation,
session, digest, size and YAML, and rejects path replacement during the read.
It is a snapshot, not an exclusion lock: the host must bind it to the later
operation. The graph `channel revalidate-state` command binds the snapshot to the
persisted preparation and checks the channel again after reading without changing
the graph. The live cutover does not yet call it and remains disabled.

A network-isolated experiment with Codex CLI 0.169.0 and a temporary home
observed a queued submission leave the queue and a turn start before an
explicit queue/start call. Without model connectivity, the full turn readback
did not expose a correlated user item in the observation window. The existing
explicit-start producer refuses an empty queue and does not retry the start.
An isolated counterexample shows that a native turn may start with empty input
and then accept a steer with the same client ID and payload while the queued
submission is still pending. Therefore `--observe-auto` is disabled and v5
proofs are rejected: readback alone does not establish queue consumption.
No waker invokes this path and a trustworthy consumption source is still needed.
