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
`describe` receives `{}` and returns the module name, its exact namespace and
supported operations. The registry must reject duplicate names or namespaces.
The registry is an operator-owned allowlist, not a marketplace or code sandbox.

The initial read-only discovery surface is `mesh-graph module list` and
`mesh-graph module describe --name <name>`. It reads the operator-owned
`$XDG_CONFIG_HOME/agent-mesh/modules.json` (or `--config <path>`). The registry
has `schemaVersion: 1` and a `modules` array containing `name`, `command` as an
argument array, and optional `timeoutMs`. Namespace equals name. A missing file
registers no modules; malformed files and duplicate names fail closed. Describe
does not update a cursor or write graph state. stderr is not returned to callers.

Before a module can make graph changes, the writer must accept a bounded batch
under the graph lock, verify its namespace and cursor precondition, and record
the batch and its next cursor atomically. Retrying an identical batch must return
its original receipt; reusing an id for different contents must fail. Module
events and attributes must survive graph replay, checkpointing and compaction.
These writer and transaction semantics are required work, not yet implemented.
