# Agent Mesh Gateway Phase 1 Architecture

## Purpose

The Agent Mesh Gateway is a sidecar package for host-agnostic agent-to-agent orchestration. Discord is treated as an observable transcript and command surface, not as the mesh protocol.

This package sits above request routing bridges. `openclaw-federation-bridge` is a policy boundary for request/reply traffic between OpenClaw instances or bridge peers; the mesh gateway is a higher-level orchestration layer for logical agents, context, lifecycle, audit, and future tool/Codex/approval facades. Phase 1 reuses bridge patterns locally without modifying or depending on the production bridge repo.

## Phase 1 Components

- Envelope schema and validation for `openclaw.agent.message.v1`.
- Context registry backed by `config/contexts.json`.
- Agent registry backed by `config/agents.json`.
- Gateway service for validation, routing, delivery lifecycle, idempotency, pause/kill-switch checks, and anti-loop checks.
- Append-only stores for audit, delivery, envelopes, execution jobs, heartbeats, idempotency, dead letters, and gateway control state.
- Package-local Guardian approval facade and approval event store for Phase 2 governed actions.
- Stub adapters for simulated agents, Discord transcript correlation mapping, and governed Codex runner execution job persistence.
- Bridge-alignment helpers that map mesh envelopes to bridge-style request/correlation/reply vocabulary for audit and operator inspection.
- Demo entrypoints for request/reply, Codex job stub creation, and state inspection.

## Storage Target

Phase 1 should use NDJSON under `var/agent-mesh/` when Jobs C/D implement behavior:

```text
var/agent-mesh/audit-events.ndjson
var/agent-mesh/approval-events.ndjson
var/agent-mesh/delivery-events.ndjson
var/agent-mesh/envelopes.ndjson
var/agent-mesh/execution-jobs.ndjson
var/agent-mesh/heartbeats.ndjson
var/agent-mesh/idempotency-events.ndjson
var/agent-mesh/gateway-control-events.ndjson
```

Startup recovery replays these stores and emits a `gateway.recovered` audit event with recovered counts and warning count.

Accepted envelope audit records include a `bridge_alignment` view, `route_policy_concept`, and `correlation_semantics` object. These are descriptive package-local mappings: they clarify how mesh routing relates to bridge concepts such as `requestId`, `correlationId`, `replyToRequestId`, idempotency, and adapter delivery, but they do not perform live cross-instance routing.

The Discord adapter remains stub-only. It emits an internal-to-Discord correlation object with internal message identifiers, intended Discord target identifiers when supplied in envelope metadata, and `no_external_send: true`.

The execution adapter remains stub-only. It records `execution_job` entries with workspace/domain/project/task correlation, source message/conversation/correlation ids, policy and approval metadata, governance decision state, and pause/cancel intent statuses. It does not start workers, spawn child processes, or perform network I/O.

The approval facade is also stub-only. For each governed execution job it records an `ApprovalGateEvaluation` with:

- request: subject kind/id, action, requesting agent, workspace/domain/project/task context, policy profile, approval profile, reviewer flow, risk flags, and `no_external_execution: true`;
- decision: `allow-once`, `deny`, or `ask-human`, the local stub status, reason, reviewer flow, and human-escalation flag.

Current local policy is intentionally small: `approval_required` execution jobs produce `ask-human`, `policy_profile: "deny_all"` or `approval_profile: "deny"` produce `deny`, and other record-only execution jobs produce `allow-once`. Future memory/tool actions can reuse the same request/decision shape without adding real approval or network I/O.

Before persistence, the gateway computes `content_hash` from canonical envelope content when callers omit it. This prevents ping-pong loop detection from depending on caller-supplied hashes. Phase 1 also rejects unredacted `sensitivity: "secret"` envelopes and obvious secret-shaped payload keys instead of persisting their content.

## Agent Model Profiles

Logical agents should have role-aware model and reasoning profiles. The mesh should be able to choose a fast/low-cost profile for routine checks, a balanced profile for normal work, and a stronger reasoning profile for complex, risky, or specialist tasks. Model selection belongs in agent/task policy and should include fallbacks, cost/latency preference, reasoning effort, and approval requirements for expensive or high-risk runs.

## Memory and Proactivity Direction

The mesh should not add a central memory broker by default. The current direction is a lightweight Memory Fabric:

- cross-host agents exchange information through prompt handoffs, artifacts, and synced folders;
- same-host OpenClaw agents share local folders and mem0 via OpenClaw configuration;
- mem0 scopes are enforced per logical agent/team/domain through the custom gateway;
- durable shared memory changes remain scoped, auditable, and approval-aware.

Proactivity is also a first-class design concern. Proactive agents should not only execute assigned work; they should improve their own operating methods. Each proactive specialist should review stale items in its domain, select better techniques, maintain checklists/playbooks, improve handoffs, and push unresolved work toward an explicit outcome. The Project Manager backlog loop is one example of this general behavior, not the only case.

## Explicit Non-Goals

- No real Discord delivery.
- No real Codex execution.
- No direct memory writes.
- No OpenClaw core modification.
- No runtime service wiring.
- No scheduler, cron, agent, or channel creation.
- No federation bridge repo changes or OpenClaw core changes.
