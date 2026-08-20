# Transports

The mesh delivers messages over one or more **transports**, each implementing the
same `MeshTransportAdapter` interface. Transports are interchangeable peers. They
do not own protocol, routing, anti-loop, idempotency, or audit logic — they share
one coordination core and only differ in how a rendered delivery reaches its
destination.

## Native Codex Desktop task control

Codex Desktop task tools are a host control surface, not a
`MeshTransportAdapter`. When both endpoints are user-visible Codex Desktop
tasks and the native tools are exposed, prefer that surface before tmux:

| Need | Preferred native capability |
| --- | --- |
| Continue an existing task | `send_message_to_thread` |
| Observe progress without attaching | `wait_threads` |
| Read recent task state | `read_thread` |
| Create a new user-owned task after an explicit user request | `list_projects`, then `create_thread` |
| Derive a task from completed thread history | `fork_thread` |

Creation is asynchronous. Treat a returned `clientThreadId` as setup-in-progress;
only a ready `threadId` may be passed to read, wait, or send operations. Project
tasks should use a worktree by default for Git repositories and the saved project
directory for non-Git projects, unless the user explicitly chooses otherwise.

Use the tmux bridge instead when the user requests tmux/agent-mesh, the task must
remain a persistent CLI session, the endpoints cross runtimes, an on-disk session
must be recovered, terminal-level control is required, or the native capabilities
are unavailable. Do not emulate missing native tools by editing Codex state or by
calling undocumented app-server protocol methods.

Native task operations do not automatically inherit Mesh envelope, anti-loop,
idempotency, approval, or audit semantics. A future native transport adapter must
implement those guarantees explicitly before it can be treated as a peer of the
adapters below.

## The shared interface

Every transport adapter implements:

```ts
dispatch(delivery: DeliveryRecord, envelope: AgentMessageEnvelopeV1): Promise<AdapterDispatchResult>;
```

Because the contract is identical, adding, swapping, or running multiple transports
side by side requires no change to the others. A delivery built for one transport
carries the same `AgentMessageEnvelopeV1`, the same `idempotency_key`, and the same
correlation/trace/causation IDs as a delivery for any other.

## Available transports

| Transport | Adapter id | Direction / surface | Real-send default | Status |
| --- | --- | --- | --- | --- |
| Discord | (controlled Discord adapter) | Human-facing command, transcript, and approval surface | Off (dry-run; real only after explicit enablement + approval) | Controlled boundary; stub-first in Phase 1 |
| Tmux | `tmux-transport` | Agent-to-agent (CLI-to-CLI) direct collaboration | Off (`enable_real_send` per route) | New peer adapter; dry-run-first |

Boundary documents:

- Discord — `packages/gateway/docs/discord-adapter-boundary.md`
- Tmux — `packages/gateway/docs/tmux-adapter-boundary.md` and
  `packages/gateway/docs/tmux-adapter-contract.md`
- Discord-connected agent awareness — `docs/discord-agent-knowledge.md`

## When each is used

- **Discord**: the observable surface for humans — status summaries, approval
  requests, transcripts, pings. It is how a person sees and steers the mesh.
- **Tmux**: direct CLI-to-CLI agent comms — one agent dispatching a prompt to
  another agent's tmux session for collaboration, without a human-facing channel
  in the loop. Backed by the `@openclaw-agent-mesh/tmux-bridge` scripts.

The choice of transport changes the destination, not the protocol or the
guarantees.

## Shared coordination core

Both transports sit behind the same core. None of the following lives in a
transport adapter:

- **Discovery / routing** — explicit targets; no transport invents recipients.
- **Anti-loop** — `evaluateAntiLoop` (TTL, expiry, self-message, ping-pong),
  evaluated before any send on every transport.
- **Delivery / audit store** — append-only NDJSON records per transport
  (`tmux-dispatch-events.ndjson` for tmux; Discord delivery/audit records for
  Discord).
- **Idempotency** — dedup by `idempotency_key`; a prior non-failed record
  suppresses re-send.
- **Approval / dry-run gates** — dry-run-first everywhere; real sends require
  explicit enablement (`enable_real_send` for tmux; explicit real-send enablement
  plus approval for Discord).
- **Sensitivity / redaction policy** — classification applies before any real
  outbound send, independent of transport.
- **Correlation semantics** — `trace_id`, `correlation_id`, `causation_id`
  preserved through delivery and audit, so a conversation stays linked even when it
  crosses transports (see `packages/gateway/docs/bridge-alignment.md`).

## Flow: envelope -> delivery -> adapter -> transport

```text
        AgentMessageEnvelopeV1
   (message_id, intent, from/to,
    content, correlation_id,
    causation_id, trace_id,
    idempotency_key)
                |
                v
        +-----------------+
        |  mesh core      |   discovery / routing
        |  coordination   |   anti-loop (evaluateAntiLoop)
        |                 |   idempotency dedup
        |                 |   sensitivity / redaction
        |                 |   dry-run / approval gate
        +-----------------+
                |
                v
          DeliveryRecord
       (target_agent_id, target,
        idempotency_key, dry_run)
                |
        dispatch(delivery, envelope)
                |
        +-------+-------------------------+
        |                                 |
        v                                 v
  +--------------+                 +-------------------+
  | Discord      |                 | TmuxTransport     |
  | adapter      |                 | Adapter           |
  | (DiscordMsg  |                 | (TmuxSessionSender|
  |  Sender)     |                 |  injected)        |
  +--------------+                 +-------------------+
        |                                 |
        v                                 v
   Discord surface                  tmux session
   (channel / thread,               (agent-send.sh ->
    embed, ping)                     target CLI agent)
                |                                 |
                +----------------+----------------+
                                 v
                    AdapterDispatchResult
              (status, external_id, details echo
               trace_id / correlation_id / causation_id)
                                 |
                                 v
                    append-only audit record
```

Both adapters receive the same `(delivery, envelope)` pair, run the same gates, and
return the same `AdapterDispatchResult` shape. They are peers, not layers.
