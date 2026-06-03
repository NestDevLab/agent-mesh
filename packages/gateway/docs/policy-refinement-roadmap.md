# Policy and Approval Refinement Roadmap

## Purpose

This roadmap tracks the broader policy layer that should evolve after the first real adapters exist. It keeps the mesh safe while moving from local stubs to controlled real CAS and Discord integrations.

## Current policy pieces

Implemented or designed:

- gateway validation and anti-loop/idempotency guards;
- kill-switch and pause-state persistence;
- local Guardian-style approval facade for execution jobs;
- Memory Fabric policy gate;
- Proactivity Engine approval boundaries;
- model/reasoning profile policy and CAS team sizing;
- CAS runner integration boundary;
- Discord adapter boundary.

## Refinement layers

### 1. Unified policy decision record

All policy decisions should converge toward one audit-friendly envelope:

```json
{
  "schema": "openclaw.agent.policy_decision.v1",
  "decision_id": "policy_...",
  "subject_kind": "execution_job|memory_action|discord_delivery|tool_action|proactivity_action|model_selection",
  "subject_id": "...",
  "decision": "allow-once|deny|ask-human",
  "risk_level": "low|medium|high|critical",
  "reason": "Human-readable reason",
  "no_external_side_effects": true
}
```

### 2. Shared risk classifier

Risk inputs should include:

- sensitivity;
- external side effects;
- target/destination;
- cost/model tier;
- tool capability;
- domain/project;
- operation reversibility;
- whether Joseph explicitly requested the action.

### 3. Approval surface routing

Approval requests should be routable to:

- local stub/audit only;
- Guardian approval broker;
- Discord approval thread;
- future operator UI.

Automated reviewers may return only:

```text
allow-once | deny | ask-human
```

No automated `allow-always`.

### 4. Adapter enablement gates

Before a real adapter is enabled, require:

- adapter boundary doc;
- dry-run planner;
- tests for deny/ask/allow paths;
- redaction checks;
- idempotency checks;
- kill-switch/pause checks;
- human approval for enabling the adapter.

## Phase order

Recommended order:

1. Stub planner for CAS runner records.
2. Stub planner for Discord delivery records.
3. Unified policy decision type.
4. Shared risk classifier.
5. Controlled single real CAS demo after approval.
6. Controlled single real Discord dry-run-to-send demo after approval.
7. Broader adapter rollout only after audit review.

## Non-goals

- No blanket tool broker access.
- No autonomous real-world writes.
- No silent memory commits to shared durable stores.
- No public/staff-facing posts without approval.
- No OpenClaw core changes.
