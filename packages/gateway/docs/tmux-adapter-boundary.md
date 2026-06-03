# Tmux Transport Adapter Boundary

## Purpose

The tmux transport is a peer of the controlled Discord adapter. It carries mesh
deliveries to CLI agents that run inside tmux sessions (Codex, Claude Code,
Gemini, …) for direct agent-to-agent collaboration. It is not the Agent Mesh
protocol; it is one transport behind the shared `MeshTransportAdapter` interface.

This document defines the boundary the tmux transport enforces. The authoritative
behavioral contract is `tmux-adapter-contract.md`; the test file
`packages/gateway/test/tmux-transport-adapter.test.js` encodes it executably.
Where this document and the contract diverge, the contract wins.

## Relationship to the Discord adapter

`TmuxTransportAdapter` implements the identical interface the Discord path uses:

```ts
readonly id = "tmux-transport";
dispatch(delivery: DeliveryRecord, envelope: AgentMessageEnvelopeV1): Promise<AdapterDispatchResult>;
```

Adding the tmux transport changes no Discord code and no Discord behavior. The two
adapters coexist behind one contract and share the mesh coordination core:
envelope schema, anti-loop evaluation, idempotency, delivery/audit stores, and the
dry-run-first send gate.

## Injected sender boundary (no direct shell calls from the package)

Mirroring `DiscordMessageSender`, the package never shells out directly. All real
sends go through an injected `TmuxSessionSender` supplied by the host runtime or by
tests:

```ts
export interface TmuxSessionSender {
  send(input: TmuxSendInput): Promise<TmuxSendResult>;
}
```

- The real host-side implementation shells out to
  `packages/tmux-bridge/bin/agent-send.sh`.
- Tests inject a fake sender; no tmux session is ever touched during tests.
- The gateway package itself contains no `tmux` invocation, no `exec`, and no host
  tool call. The boundary is the injected interface, exactly as for Discord.

## Current state

Implemented today:

- `TmuxTransportAdapter` behind the shared `MeshTransportAdapter` interface;
- injectable `TmuxSessionSender` boundary (no host shell calls from the package);
- dry-run-first behavior: `stubbed` unless a route sets `enable_real_send === true`;
- idempotency dedup by `idempotency_key` against the append-only audit store;
- reuse of `evaluateAntiLoop` (TTL, expiry, self-message, ping-pong);
- append-only NDJSON audit trail in `tmux-dispatch-events.ndjson`;
- correlation/trace/causation IDs preserved in adapter output and audit records;
- fake-sender tests for anti-loop reject, no-route, dedup, stubbed dry-run,
  delivered, and sender-failure cases.

## Routing

Routes are explicit. There is no discovery and no implicit targeting:

```ts
export interface TmuxRoute {
  target_agent_id: string;
  tmux_target: string;        // tmux session name
  enable_real_send?: boolean; // default false => stubbed (dry-run-first)
}
```

A delivery is dispatched only if a route exists where
`target_agent_id === delivery.target_agent_id`. With no matching route, dispatch
fails with reason `"no_route_for_target"` and the sender is never called.

## dispatch() lifecycle

The adapter enforces this ordered pipeline (see the contract for exact field
semantics):

```text
mesh delivery + envelope
  -> anti-loop evaluation (evaluateAntiLoop)
       rejected -> status:"failed", sender_called:false, reason:<anti-loop reason>
  -> route resolution by target_agent_id
       no route -> status:"failed", reason:"no_route_for_target"
  -> idempotency check by idempotency_key
       prior non-failed record -> return prior status, details.deduplicated:true (sender not called)
  -> render prompt from envelope.content (text -> summary -> JSON.stringify)
  -> dry-run gate: enable_real_send !== true
       -> status:"stubbed", sender_called:false, reason:"dry_run_no_real_send" (sender not called)
  -> real send via injected sender.send(...)
       ok:true  -> status:"delivered"
       ok:false -> status:"failed", reason:<error>
  -> append TmuxDispatchRecord to the audit store
  -> return AdapterDispatchResult echoing trace_id, correlation_id, causation_id,
     tmux_target, target_agent_id
```

The sender is called only in the real-send step, and only after anti-loop, route
resolution, idempotency, and the dry-run gate have all passed.

## Dry-run-first / `enable_real_send` gate

Real sends are off by default. A route is stubbed unless it explicitly sets
`enable_real_send: true`. A stubbed dispatch records `status:"stubbed"`,
`sender_called:false`, and reason `"dry_run_no_real_send"`, and returns a preview
(`tmux_target`, `prompt_preview`) without contacting any tmux session. This mirrors
the Discord adapter's `dry_run` default and the `allowRealSends` requirement.

## Idempotency

Each outbound delivery carries an `idempotency_key`. Before any send, the adapter
checks the audit store for an existing non-failed record with that key. On a hit it
returns the prior status with `details.deduplicated: true` and does not call the
sender. Failed records do not suppress retries.

## Anti-loop reuse

The adapter reuses the mesh's shared `evaluateAntiLoop(envelope, { clock, history,
maxRepliesPerConversation })`. The same TTL, expiry, self-message, and ping-pong
protections that guard every mesh transport apply here. A rejected envelope fails
the dispatch and the sender is never called. The tmux transport defines no
transport-specific loop logic of its own.

## Audit store

The adapter appends a `TmuxDispatchRecord` for every dispatch outcome to an
append-only NDJSON file, `tmux-dispatch-events.ndjson`, under the package-local
state directory. `TmuxDispatchStore` exposes `append(record)`, `list()`, and
`listByIdempotencyKey(key)`. Each record carries:

- `id` (`newEventId("tmux_dispatch")`), `message_id`, `adapter_id` (`"tmux-transport"`);
- `target_agent_id`, `tmux_target`, `idempotency_key`;
- `status` (`delivered` | `failed` | `stubbed`), `sender_called`, `reason`;
- `trace_id`, `correlation_id`, `causation_id`, `created_at`.

This matches the Discord adapter's append-only delivery/audit discipline.

## Correlation-id preservation

`trace_id`, `correlation_id`, and `causation_id` from the envelope are preserved in
both the audit record and the `AdapterDispatchResult.details`. Correlation grouping
is identical to the Discord path, so a conversation that crosses transports stays
linked by the same correlation semantics described in `bridge-alignment.md`.

## Out of scope (explicit)

The tmux transport does **not**, and must not without separate work and approval:

- auto-start, create, or resume tmux sessions — routing targets an existing
  `tmux_target`; session lifecycle (`agent-session.sh`) is out of band;
- perform unattended real sends — a send requires an explicit
  `enable_real_send: true` route in addition to passing every pipeline gate;
- shell out from the gateway package — all host interaction is through the
  injected `TmuxSessionSender`;
- discover or infer targets — only configured `TmuxRoute` entries are dispatched;
- define its own loop, idempotency, or audit logic — it reuses the shared mesh
  primitives;
- alter Discord routing, naming, embeds, pings, approval gates, or any Discord
  behavior — those are untouched.

## Next safe implementation

Wire the host-owned `TmuxSessionSender` (backed by
`packages/tmux-bridge/bin/agent-send.sh`) outside this package, using the same
injected interface, without changing the tmux-bridge scripts or hardcoding host
paths. Any real-send smoke must be separately approved and narrowly scoped, exactly
as for the Discord adapter.
