# Plexus external modules

Status: design in progress. This document does not authorize a live rollout.

Plexus provides a generic extension boundary. Module commands, configuration and
private data belong to the operator; Plexus does not embed the policy of a module.
An external module must be invoked without a shell and must identify itself with
`describe`. A module keeps its own durable event cursor and may only write
attributes and events in its registered namespace. The registry is private and
must be explicitly configured; absence of configuration enables no modules.

## Lifecycle evidence

The lifecycle vocabulary is `session.started`, `session.woken`, `session.idle`,
`session.compacted`, `session.stopped`, and `session.handover`. A producer may
record one of these only when it has evidence for that transition. Discovery,
quietness, a queued message, or an expired lease alone are not proof that a
process stopped, compacted or handed over. Event ids must be stable on retry.

`session.woken` means that a wake-caused turn was actually observed for the
named session, with source evidence that binds the wake to that turn. Starting
a process, scheduling or accepting a message, or a generic unrelated turn is
not proof of a wake. Use a stable observation id across retries and deduplicate
the feed by `eventId`. A missing wake event is not evidence of zero wakes;
consumers must establish source and time-window coverage separately. This
contract does not itself install or enable a wake-event producer.

An experimental, explicitly invoked Codex adapter can bind an exact queued
submission and waker correlation to the turn returned by `thread/queue/start`.
It requires a full native thread readback with the same turn, start time,
message client id and input; incomplete or mismatched readback is unknown.
It first reserves the queue identity durably in a private evidence directory;
an ambiguous response leaves that identity reserved and requires manual
reconciliation rather than an automatic retry. Evidence records the session,
queue id, correlation, turn id and native start time, without message content;
its content-addressed reference can be checked locally with `--verify`.
Publishing a retained proof is idempotent. The operator must use one protected
evidence root and trust the local socket and waker's correlation: the file is
not an attestation against a local writer. `--apply` actually starts a queued
turn. Nothing schedules or enables this adapter, and its native behavior has
only been exercised with a synthetic server, not verified against a live runtime.
It is not connected to the waker or Limen and does not prove historical coverage.
For the native Codex stdin queue path, the transport receipt exposes the native
queue id alongside its session and correlation. The channel waker persists this
id in the same accepted queue item and generation when supplied. This proves
queue acceptance only; the waker does not yet invoke the wake-evidence adapter.
An ambiguous send remains inflight and cannot be automatically retried.

For a specific known Codex compaction, `codex-compaction-evidence.mjs` performs
an on-demand read of the configured local app server. It requires the exact
thread, turn and `contextCompaction` item, a full turn view and a recorded item
completion timestamp. It writes a private, content-addressed evidence record
before idempotently recording `session.compacted` in an explicitly selected
graph; the command never defaults to the live graph. A local
consumer can resolve it with `--verify <reference> --session <session>
--evidence-root <directory>`, which checks the private file, digest and session.
This relies on an operator-controlled root and local app-server socket; the
record is not a cryptographic attestation against an untrusted local writer.
The feed's `at`
is the recording time; the evidence's `completedAtMs` is the native item time.
An absent item, partial view, unavailable timestamp, failed read or graph error
is unknown, never zero. This tool does not discover items, establish complete
history coverage, observe Claude, schedule collection or authenticate an
untrusted local socket. The operator must protect the socket and evidence root.
Older graph readers must understand the new lifecycle event before use.

Events use the graph's existing ordered, append-only store. Their consumers must
detect the retention watermark and report an expired cursor rather than silently
skip events. Graph projection, checkpoints, snapshots and compaction must remain
replayable with these events; deployments must account for older readers that
reject unknown event types before any producer is enabled.
The local unscoped change feed includes the opaque evidence reference so a
trusted registered module can inspect it. Scoped feeds omit that reference;
visibility of a session does not grant access to its evidence source. A
reference is not itself proof that its target has been verified.

## Isolation requirements

Namespacing must be enforced by the graph writer, not trusted to an executable.
A module must not change session identity, ownership, another module's state, or
core graph facts. Configuration is an authority boundary: arbitrary commands are
not accepted from events, graph attributes, user text or remote clients. Invocation
must be bounded by a timeout and an output limit; diagnostics must not leak
private inputs. A crash, invalid response or partial write must not advance the
module's cursor. Retry semantics must not duplicate committed changes.

Module conformance tests must cover protocol identity, namespace enforcement,
independent cursors, retries, malformed responses, timeout, and retention gaps.
The example module and all fixtures use synthetic data only.

## Proposed process protocol

The host invokes a configured argument vector followed by an operation; no shell
expansion is involved. Requests and responses are single JSON objects on stdin
and stdout. Every response identifies protocol `agent-mesh.plexus-module.v1`.
`describe` receives `{}` and returns the module name, its exact namespaces and
supported operations. The registry must reject duplicate names or namespaces.
The registry is an operator-owned allowlist, not a marketplace or code sandbox.

The initial read-only discovery surface is `mesh-graph module list` and
`mesh-graph module describe --name <name>`. It reads the operator-owned
`$XDG_CONFIG_HOME/agent-mesh/modules.json` (or `--config <path>`). The registry
has `schemaVersion: 1` and a `modules` array containing `name`, `command` as an
argument array, optional `namespaces` (default: the module name), and optional
`timeoutMs`. One command may own several namespaces. A missing file
registers no modules; malformed files and duplicate names fail closed. Describe
does not update a cursor or write graph state. stderr is not returned to callers.
Process requests are capped at 32 MiB; responses and configuration at 1 MiB.
Oversized requests fail without advancing the cursor rather than silently
truncating the graph. These limits are not a substitute for future pagination.

`module run --name <name>` observes the graph and a page from the module's
cursor without holding the writer lock during feed replay. If the graph moves
during observation or before commit, the run fails without advancing its cursor.
The host invokes `process` outside the lock, validates its response and commits
the bounded batch and cursor as one graph event under the lock. An intervening
run for the same module causes a cursor conflict. The request contains `schema`, `graph`, `cursor`, and `events`; the
response contains `schema`, `name`, `batchId`, `attributes`, and `events`.
Attributes identify a session and a namespaced key; they are projected under
that namespace on its node. Events identify a session, a namespaced type, and JSON data.
The cursor is host-owned, not selected by a module. An initial run starts at the
current head; an expired cursor fails closed and requires reconciliation. A
no-change run does not append a new batch solely to observe its own events.

`module apply` is an operator-level interface for an already computed batch;
the configured name determines its permitted namespaces. Both paths check the cursor and
the last batch id while holding the graph lock. An identical retry of the last
batch returns a duplicate receipt, while a reused id with different content or
an older cursor fails. No exactly-once guarantee is claimed for arbitrary
external effects made by an executable. `module conformance` checks a synthetic
description and process response with `mode: "conformance"` and synthetic graph
data; a module must not contact live sources in that mode. This command is not a sandbox or a proof of side-effect
isolation. Configuration and OS access remain under the operator's control.
