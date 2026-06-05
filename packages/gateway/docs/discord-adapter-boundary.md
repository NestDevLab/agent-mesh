# Controlled Discord Adapter Boundary

## Purpose

Discord is an observable command, transcript, and approval surface. It is not the Agent Mesh protocol. This document defines the boundary required before the mesh can perform real Discord writes.

Phase 2 has moved past stub-only for the controlled adapter boundary after the operator's explicit approval. The package still must not call the OpenClaw message tool directly; any real send path must go through an injected sender supplied by the host runtime or tests.

## Current state

Implemented today:

- Discord transcript stub adapter;
- internal-to-Discord correlation records;
- `no_external_send: true` behavior;
- no real channel/thread/message creation from the mesh package.
- controlled Discord sender boundary with an injectable sender interface;
- `OpenClawHostMessageSender`, a runtime binding facade that adapts `DiscordMessageSender` to a host-provided OpenClaw `message/send`-shaped function without importing or calling that tool;
- local send attempt/result records;
- fake-sender tests for approved, denied, ask-human, secret, unconfigured, pause, and kill-switch cases;
- fake-host tests proving dry-run invocation, default real-send rejection, deterministic channel/thread mapping, and host failure propagation.

## Required boundary before real Discord writes

The controlled Discord adapter enforces:

- explicit target guild/channel/thread id;
- explicit allowed message kinds;
- per-domain routing policy;
- redaction/sensitivity policy before sending;
- idempotency key for each outbound message;
- append-only delivery/audit records;
- dry-run preview mode;
- human approval for sensitive/external-facing posts;
- kill-switch and pause-state checks;
- no automatic channel/thread creation unless approved.
- no direct OpenClaw message tool dependency.

## Host binding facade

The host binding facade accepts the existing package-local `DiscordMessageSendRequest` and builds a strict host request:

```json
{
  "channel": "discord",
  "target": {
    "surface": "discord",
    "type": "thread",
    "channel_id": "channel-1",
    "thread_id": "thread-1"
  },
  "content": {
    "title": "Status",
    "body": "Dry-run only."
  },
  "idempotency_key": "idem-host-discord-1",
  "dry_run": true,
  "metadata": {
    "facade": "openclaw-agent-mesh-gateway.discord-host-message-sender.v1",
    "smoke": true,
    "source": "agent-mesh-gateway",
    "direct_openclaw_message_tool_call": false
  }
}
```

`dry_run` defaults to `true`. Constructing the facade with `dryRun: false` still rejects the operation unless `allowRealSends: true` is also explicit. The package remains safe to test with fake host functions and still performs no real Discord send on its own.

## Allowed message kinds, initially

| Kind | Default |
| --- | --- |
| `safe_status_summary` | allowed only in dry-run until approval |
| `approval_request` | dry-run first; real only after approval |
| `task_thread_summary` | dry-run first |
| `incident_or_blocker` | ask-human unless urgent policy configured |
| `audit_digest` | dry-run first |

Forbidden by default:

- public announcements;
- messages containing secrets/private data;
- broad pings/mentions;
- channel/thread/category creation;
- deletion/editing of existing user-authored content.

## Delivery lifecycle

```text
mesh event
  -> classify Discord visibility
  -> redact/summarize
  -> route to target thread/channel policy
  -> dry-run delivery record
  -> optional approval
  -> real send through OpenClaw message adapter
  -> delivery status/audit update
```

## Redaction policy

Before real send, every outbound payload must be classified:

- `public`: safe to send if routing policy allows;
- `internal`: safe only in authorized internal channel/thread;
- `private`: ask-human unless explicitly scoped;
- `confidential`: ask-human and redact by default;
- `secret`: deny unless fully redacted.

## Adapter input

```json
{
  "delivery_id": "delivery_...",
  "message_kind": "approval_request",
  "workspace_id": "workspace.the operator",
  "domain_id": "domain.nestdev",
  "target": {
    "surface": "discord",
    "channel_id": "...",
    "thread_id": "..."
  },
  "content": {
    "title": "Approval needed",
    "body": "Safe concise summary"
  },
  "sensitivity": "internal",
  "redaction_state": "redacted",
  "idempotency_key": "...",
  "dry_run": true,
  "no_external_send": true
}
```

## Adapter output

```json
{
  "delivery_id": "delivery_...",
  "status": "stubbed|sent|failed|waiting_approval|denied",
  "no_external_send": true,
  "discord_message_id": null,
  "summary": "Dry-run Discord delivery recorded."
}
```

## Human approval gate

Human approval is required before enabling real sends if:

- the message is not purely internal and low-risk;
- the message contains private/confidential material;
- the destination is not explicitly configured;
- the action creates/edits/deletes Discord objects;
- the send could represent the operator, a project, or staff-facing operational policy.

## Phase 2 next safe implementation

Completed: Discord delivery planner records remain the required dry-run prerequisite. The controlled adapter can call only an injected sender, and only after explicit real-send enablement, an approved policy decision for the exact plan, configured target, acceptable sensitivity/redaction, non-empty idempotency key, accepted kill-switch/pause guard, and explicit message-create permission.

Next safe implementation: wire a host-owned OpenClaw/Discord sender outside this package, with the same injected interface and without changing OpenClaw core/runtime config from this package. Any real-send smoke must be separately approved and narrowly scoped.
