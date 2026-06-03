# Proactivity Engine Design

## Purpose

The Proactivity Engine is the Phase 2 design for scheduled, event-driven, and self-improving agent behavior in Agent Mesh.

Proactivity is not just cron. Each proactive agent has two loops:

```text
operational loop  -> do the assigned or scheduled work
improvement loop  -> inspect outcomes, tune methods/checklists, reduce future friction
```

The Project Manager / Chief of Staff backlog loop is one concrete example. Every proactive specialist should have an analogous domain loop.

## Guardrails

Phase 2 remains design/stub-first:

- no real cron jobs are created;
- no Discord messages are sent;
- no external tools are called;
- no OpenClaw runtime configuration is modified;
- no worker jobs are launched from proactivity;
- no memory commits are executed without the Memory Fabric policy gate and approval rules.

The engine may model schedules, triggers, policies, and audit records locally. Real adapters require a later explicit approval.

## Trigger types

| Trigger | Description | Phase 2 behavior |
| --- | --- | --- |
| `scheduled` | Periodic cadence such as daily, weekly, monthly | Record-only plan/stub; no cron creation. |
| `heartbeat` | OpenClaw heartbeat or mesh heartbeat event | Local simulated trigger only. |
| `staleness` | Item/thread/task has not advanced past threshold | Generates review proposal. |
| `failure_pattern` | Repeated tool, handoff, delivery, or workflow failures | Generates improvement proposal. |
| `inbox_signal` | New item appears in monitored intake/inbox | Generates triage proposal. |
| `human_request` | Joseph asks an agent/team to proceed | Routes to operational loop. |
| `post_outcome_review` | Completed work should update playbooks/checklists | Routes to improvement loop. |

## Proactivity cycle

```text
trigger observed
  -> context and agent registry check
  -> policy/risk classification
  -> candidate action proposal
  -> approval decision if needed
  -> stub execution record or handoff
  -> outcome/audit record
  -> optional improvement proposal
```

Each cycle must declare:

- `workspace_id`
- `domain_id`
- optional `project_id` and `task_id`
- `agent_id`
- `trigger_kind`
- `loop_kind`: `operational` or `improvement`
- `proposed_action_kind`
- `risk_level`
- `approval_policy`
- `memory_policy_scope`
- `no_external_execution` during stub phases

## Action kinds

Initial proposed action kinds:

```text
triage
summarize
prioritize
split
merge
archive_proposal
escalate
handoff
checklist_update_proposal
playbook_update_proposal
memory_proposal
execution_job_proposal
research_proposal
security_review_proposal
backoffice_review_proposal
design_review_proposal
```

The engine proposes actions; adapters decide whether any real work is permitted.

## Domain backlog hygiene policy

Backlog hygiene is not “keep everything forever”. Each stale item should move toward one explicit outcome:

```text
do | defer | delegate | drop | decide | automate | escalate
```

Default stale-item handling:

| Condition | Proposal |
| --- | --- |
| unclear task with no owner | split or clarify |
| duplicate task/thread | merge |
| blocked item with named blocker | escalate or ask human |
| low-value/no-longer-relevant item | archive/drop proposal |
| repeated manual task | automation proposal |
| sensitive or high-impact task | ask-human before action |

## Agent-specific loops

### `agent.chief_of_staff`

Operational loop:

- scan active domain/project/task states;
- identify blockers, stale work, missing owners, and conflicting priorities;
- produce triage/prioritization/handoff proposals.

Improvement loop:

- refine backlog taxonomy;
- update task triage checklists;
- detect recurring stuck patterns;
- suggest cadence changes and responsibility boundaries.

### `agent.software_engineer`

Operational loop:

- prepare scoped implementation proposals;
- create governed `execution_job_proposal` records;
- summarize code/test outcomes for review.

Improvement loop:

- update repo playbooks after repeated failures;
- propose better test/build gates;
- detect missing automation or flaky workflows;
- improve handoff format to configured workers.

### `agent.security`

Operational loop:

- review risk signals, exposed services, policy drift, and sensitive action proposals;
- produce security-review proposals.

Improvement loop:

- maintain hardening checklists;
- identify recurring misconfigurations;
- tune risk classification rules.

### `agent.memory_curator`

Operational loop:

- convert approved durable insights into memory proposals;
- detect stale, duplicate, or conflicting notes.

Improvement loop:

- tune memory scope taxonomy;
- improve provenance and citation quality;
- propose wiki/memory cleanup plans without direct writes.

### `agent.research`

Operational loop:

- prepare research summaries and source-backed briefs;
- hand off compact findings to the requesting agent.

Improvement loop:

- improve query patterns and source quality rules;
- maintain domain research checklists.

### `agent.backoffice`

Operational loop:

- triage document/accounting/admin workflow proposals;
- detect missing confirmations or pending paperwork.

Improvement loop:

- improve intake checklists;
- detect recurring missing metadata;
- propose safer document workflows.

### `agent.designer`

Operational loop:

- prepare design briefs, asset requests, and review proposals.

Improvement loop:

- maintain design-system/playbook notes;
- detect repeated ambiguity in briefs;
- improve handoff templates.

## Approval rules

The Proactivity Engine never bypasses approval gates.

Default policy:

| Proposal | Default decision |
| --- | --- |
| Read-only local summarization | `allow-once` stub/record-only |
| Checklist/playbook update proposal | `allow-once` proposal-only |
| Durable memory update | Memory Fabric policy gate |
| External write/post/send | `ask-human` or `deny` until adapter approval |
| Worker execution | Approval gate + worker policy |
| Deletion/archive/drop | `ask-human` unless explicitly configured |
| High-cost model/tool run | model policy approval gate |

## State model

A future implementation should persist proactivity records as NDJSON:

```text
var/agent-mesh/proactivity-events.ndjson
var/agent-mesh/proactivity-decisions.ndjson
var/agent-mesh/proactivity-outcomes.ndjson
```

Minimal record shape:

```json
{
  "schema": "openclaw.agent.proactivity.v1",
  "event_id": "proactivity_...",
  "created_at": "2026-05-10T00:00:00.000Z",
  "workspace_id": "workspace.joseph",
  "domain_id": "domain.nestdev",
  "agent_id": "agent.chief_of_staff",
  "trigger_kind": "staleness",
  "loop_kind": "operational",
  "proposed_action_kind": "triage",
  "risk_level": "low",
  "approval_policy": "none|notify|ask|block_until_approved",
  "memory_policy_scope": "domain.nestdev",
  "no_external_execution": true,
  "summary": "Review stale NestDev tasks and propose next outcomes."
}
```

## Discord visibility

Discord should show readable summaries only after an adapter is explicitly enabled. Until then, the engine records transcript-mapping stubs compatible with the existing Discord transcript adapter.

Future Discord output should be concise:

- what triggered the proactive review;
- what the agent proposes;
- what approval, if any, is needed;
- links/references to internal audit state where safe.

## Phase 2 acceptance criteria

This design block is complete when:

- trigger kinds are documented;
- operational and improvement loops are defined;
- agent-specific loop expectations are recorded;
- backlog hygiene outcomes are explicit;
- approval boundaries are clear;
- no real scheduler/cron/Discord/tool side effects are introduced.
