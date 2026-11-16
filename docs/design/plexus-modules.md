# Plexus external modules

Status: design in progress. This document does not authorize a live rollout.

Plexus provides a generic extension boundary. Module commands, configuration and
private data belong to the operator; Plexus does not embed the policy of a module.
An external module must be invoked without a shell and must identify itself with
`describe`. A module keeps its own durable event cursor and may only write
attributes and events in its registered namespace. The registry is private and
must be explicitly configured; absence of configuration enables no modules.

## Lifecycle evidence

The lifecycle vocabulary is `session.started`, `session.idle`,
`session.compacted`, `session.stopped`, and `session.handover`. A producer may
record one of these only when it has evidence for that transition. Discovery,
quietness, a queued message, or an expired lease alone are not proof that a
process stopped, compacted or handed over. Event ids must be stable on retry.

Events use the graph's existing ordered, append-only store. Their consumers must
detect the retention watermark and report an expired cursor rather than silently
skip events. Graph projection, checkpoints, snapshots and compaction must remain
replayable with these events; deployments must account for older readers that
reject unknown event types before any producer is enabled.

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

`module run --name <name>` captures the graph and a page from the module's
cursor under the graph lock, then invokes `process` outside the lock. The host
validates its response and commits the bounded batch and cursor as one graph
event under the lock. An intervening run for the same module causes a cursor
conflict. The request contains `schema`, `graph`, `cursor`, and `events`; the
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
description and process response; it is not a sandbox or a proof of side-effect
isolation. Configuration and OS access remain under the operator's control.
