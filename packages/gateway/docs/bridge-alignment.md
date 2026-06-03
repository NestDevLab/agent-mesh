# Bridge Alignment

## Boundary

`openclaw-federation-bridge` is a request routing bridge. It is the policy boundary for callers crossing between OpenClaw instances or bridge peers.

`openclaw-agent-mesh-gateway` is an orchestration mesh sidecar. It coordinates logical agents, context, delivery lifecycle, audit, and future tool/Codex/approval facades. It can reuse bridge patterns, but it is not the production bridge and does not replace bridge policy.

Phase 1 keeps this package stub-safe:

- no OpenClaw core changes;
- no federation bridge repo changes;
- no real Discord writes;
- no real Codex execution;
- no external side effects.

## Pattern Mapping

The mesh envelope intentionally maps onto bridge vocabulary so the architecture stays understandable:

| Federation bridge concept | Mesh package concept | Phase 1 behavior |
| --- | --- | --- |
| `requestId` | `message_id` | Stored on the mesh envelope and audit events. |
| `correlationId` | `correlation_id`, falling back to `trace_id` or `message_id` | Used for trace grouping and Discord transcript correlation. |
| `replyToRequestId` | `causation_id` on reply envelopes | Described as correlation semantics; not yet enforced as a live reply-window policy. |
| `mode` | `intent` | Supports request, reply, notification, approval, memory proposal, execution job, and heartbeat intents. |
| `source` / `destination` | `from` / `to` agent ids | Logical agent ids, not necessarily host or runtime ids. |
| `operation` | `agent_mesh.<intent>` | A bridge-style operation label for audit and future adapter work. |
| `payload` | `content` | JSON object payload guarded before persistence. |
| `idempotencyKey` | `idempotency_key` | Checked by the package-local idempotency store. |
| append-only request store | append-only envelope, delivery, audit, heartbeat, and execution-job stores | NDJSON under package-local state. |
| adapters | simulated agent, Discord transcript stub, Codex runner stub | Local stubs only. |

## Package-Local Helpers

`src/core/bridge-alignment.ts` provides pure helpers:

- `mapEnvelopeToBridgeAlignedView()` produces a bridge-shaped view of a mesh envelope for audit and inspection.
- `deriveMeshRoutePolicyConcept()` names the package-local route policy concept without claiming live bridge enforcement.
- `describeCorrelationSemantics()` exposes trace/correlation/causation semantics, including parentless replies, without changing runtime behavior.

The gateway includes these details in `envelope.accepted` audit records. This makes the relationship to the federation bridge explicit while keeping the mesh package independent and stub-safe.

## What Is Deliberately Not Reused Yet

The mesh does not copy the federation bridge reply-window enforcement into Phase 1. The bridge protects cross-instance request/reply boundaries. The mesh currently models higher-level logical agent orchestration and records the semantics needed for a later policy engine.

When real cross-host delivery is added, adapter-level routing should either call an existing bridge/peer-gateway boundary or implement an equivalent package-local policy explicitly. Until then, all route policy concepts in this package are descriptive and local.
