# Tmux Transport Adapter — Contract (TDD source of truth)

This document is the authoritative contract for the tmux transport. The test file
`packages/gateway/test/tmux-transport-adapter.test.js` encodes it executably.

## Goal

Make the tmux bridge a **first-class mesh transport**, a peer of the Discord adapter,
behind the identical `MeshTransportAdapter` interface. No Discord code changes.

## Interface

`TmuxTransportAdapter implements MeshTransportAdapter`:

```ts
readonly id = "tmux-transport";
dispatch(delivery: DeliveryRecord, envelope: AgentMessageEnvelopeV1): Promise<AdapterDispatchResult>;
```

### Injected sender (no direct shell calls from the package)

Mirrors `DiscordMessageSender`. The real implementation shells out to
`packages/tmux-bridge/bin/agent-send.sh`; tests inject a fake.

```ts
export interface TmuxSessionSender {
  send(input: TmuxSendInput): Promise<TmuxSendResult>;
}
export interface TmuxSendInput {
  target_agent_id: string;
  tmux_target: string;
  prompt: string;
  message_id: string;
  idempotency_key: string;
}
export interface TmuxSendResult {
  ok: boolean;
  reply?: string;
  error?: string;
}
```

### Routing

```ts
export interface TmuxRoute {
  target_agent_id: string;
  tmux_target: string;        // tmux session name
  enable_real_send?: boolean; // default false => stubbed (dry-run-first, like Discord)
}
```

### Constructor options

```ts
export interface TmuxTransportAdapterOptions {
  sender: TmuxSessionSender;
  routes: readonly TmuxRoute[];
  stateDir?: string;
  clock?: StoreClock;
  history?: readonly AgentMessageEnvelopeV1[]; // for anti-loop
  maxRepliesPerConversation?: number;
}
```

## dispatch() behavior (ordered)

1. **Anti-loop**: call `evaluateAntiLoop(envelope, { clock, history, maxRepliesPerConversation })`.
   If rejected → record `status:"failed"`, `sender_called:false`, `reason:<anti-loop reason>`; return
   `{ status:"failed", details:{ reason } }`. **Do not call the sender.**
2. **Route resolution**: find route where `target_agent_id === delivery.target_agent_id`.
   If none → record `status:"failed"`, reason `"no_route_for_target"`; return `{ status:"failed", details:{ reason } }`.
3. **Idempotency**: if the store already has a non-failed record with this `idempotency_key`,
   return `{ status:<prior>, external_id:<prior.id>, details:{ deduplicated:true } }` **without calling the sender**.
4. **Render prompt** from `envelope.content`: prefer `content.text`, else `content.summary`, else `JSON.stringify(content)`.
5. **Dry-run gate**: if `route.enable_real_send !== true` → record `status:"stubbed"`, `sender_called:false`,
   reason `"dry_run_no_real_send"`; return `{ status:"stubbed", external_id:<record.id>, details:{ tmux_target, prompt_preview } }`.
   **Do not call the sender.**
6. **Real send**: call `sender.send(...)`. `ok:true` → `status:"delivered"`; else → `status:"failed"` with `reason:error`.
7. **Record** a `TmuxDispatchRecord` to `TmuxDispatchStore` and **return** an `AdapterDispatchResult` whose
   `details` echoes `trace_id`, `correlation_id`, `causation_id`, `tmux_target`, and `target_agent_id`.

## Audit record

```ts
export interface TmuxDispatchRecord {
  id: string;                 // newEventId("tmux_dispatch")
  message_id: string;
  adapter_id: "tmux-transport";
  target_agent_id: string;
  tmux_target: string;
  idempotency_key: string;
  status: "delivered" | "failed" | "stubbed";
  sender_called: boolean;
  reason: string;
  trace_id?: string | null;
  correlation_id?: string | null;
  causation_id?: string | null;
  created_at: string;
}
```

`TmuxDispatchStore` (NDJSON, file `tmux-dispatch-events.ndjson`) exposes:
`append(record)`, `list()`, `listByIdempotencyKey(key)`.

## Discord-compatibility invariants honored

- Injected sender — no host tool calls from the package.
- Dry-run-first: stubbed unless `enable_real_send === true`.
- Idempotency dedup by `idempotency_key`.
- Anti-loop reused (TTL, expiry, self-message, ping-pong).
- Append-only NDJSON audit trail.
- Correlation/trace/causation IDs preserved in output + audit.
