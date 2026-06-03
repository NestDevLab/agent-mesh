# Agent Model and Reasoning Policy

## Purpose

The Agent Mesh must choose model and reasoning settings by role, task type, complexity, risk, latency, and cost. A single global default is not enough for a multi-agent system.

This document defines the Phase 2 policy design. It does not enable real model switching, launch CAS jobs, or modify OpenClaw runtime configuration.

## Principles

- Model choice is policy-driven, not hardcoded in agent logic.
- Cheap/fast profiles handle routine low-risk work.
- Stronger models and higher reasoning are reserved for complex, risky, or ambiguous work.
- Expensive or high-impact runs can require approval.
- Every selection records why the profile was chosen.
- Fallbacks must be explicit.
- Real adapter support is optional; until then selections are advisory/stubbed.

## Selection inputs

A model decision should consider:

- `agent_id`
- agent role and capability
- `workspace_id`, `domain_id`, optional `project_id` and `task_id`
- task kind: triage, research, code, security, memory, backoffice, design, approval review
- complexity: `low`, `medium`, `high`
- risk: `low`, `medium`, `high`, `critical`
- sensitivity: `public`, `internal`, `private`, `confidential`, `secret`
- expected latency and cost tolerance
- required tools/adapters
- whether external side effects are possible
- whether a human approval gate is required

## Profile tiers

| Tier | Use | Default behavior |
| --- | --- | --- |
| `routine_fast` | Low-risk triage, formatting, summaries, checklist maintenance | low cost, low/medium reasoning |
| `balanced` | Normal planning, coordination, domain handoffs | balanced cost/reasoning |
| `deep_reasoning` | Ambiguous planning, architecture, complex debugging, security analysis | stronger model, high reasoning |
| `specialist_coding` | Code implementation/review through CAS/Codex-style workers | CAS-backed, scoped workspace, approval-aware |
| `safety_review` | Approval, security, sensitive memory/tool/CAS decisions | stronger review policy, conservative defaults |
| `local_private` | Private/local-only recall/summarization where supported | local model preference, no external provider by default |

## Agent defaults

### `agent.chief_of_staff`

- routine: `balanced`
- complex prioritization / conflict resolution: `deep_reasoning`
- approval escalation: `safety_review`
- cost preference: balanced, avoid expensive runs for simple triage

### `agent.software_engineer`

- planning/review: `deep_reasoning`
- implementation: `specialist_coding`
- small routine summaries: `balanced`
- risky repo operations: approval required
- real code development should be orchestrated through CAS teams appropriate to task complexity

### `agent.security`

- default: `safety_review`
- complex audit: `deep_reasoning`
- low-risk checklist updates: `balanced`
- bias toward deny/ask-human for external side effects

### `agent.memory_curator`

- routine memory proposals: `balanced`
- sensitive/private/conflicting memory: `safety_review`
- large synthesis: `deep_reasoning`
- secret/private recall should prefer `local_private` when available

### `agent.research`

- quick lookup/summarization: `balanced`
- source-heavy or strategic research: `deep_reasoning`
- sensitive/private research context: `local_private` or approval-gated external use

### `agent.backoffice`

- routine admin/document triage: `balanced`
- financial/legal/privacy-sensitive review: `safety_review`
- document extraction with sensitive data: approval-aware, no uncontrolled external provider

### `agent.designer`

- simple creative briefs: `balanced`
- brand/system-level design reasoning: `deep_reasoning`
- image generation or public-facing assets: approval-aware when external/public

## Decision table

| Condition | Profile |
| --- | --- |
| low complexity + low risk + no external side effects | `routine_fast` or agent default |
| normal domain planning | `balanced` |
| high ambiguity or architecture | `deep_reasoning` |
| code implementation | `specialist_coding` via CAS team |
| code review/security review | `deep_reasoning` or `safety_review` |
| high-risk external write | `safety_review` + ask-human |
| private/secret context | `local_private` when available, otherwise approval-aware stronger policy |
| repeated failures/flaky behavior | escalate one tier and create improvement proposal |

## CAS team sizing rule

When code implementation is needed, the mesh should not default to a single ad-hoc worker. It should choose a CAS team size appropriate to complexity:

| Complexity | CAS orchestration |
| --- | --- |
| small | one CAS worker or direct edit if truly trivial and explicitly safe |
| medium | two CAS roles: implementer + reviewer/QA |
| high | three or more roles: architect, implementer(s), reviewer/QA/security |
| integration with external side effects | design/review first, then implementation only after required approvals |

CAS workers must receive guardrails:

- no OpenClaw core changes;
- no external writes unless explicitly approved;
- no secrets in prompts beyond necessary scoped context;
- run tests/typecheck and report exact results;
- keep package boundaries and checklists updated.

## Approval requirements

Require human approval or safety-review escalation for:

- high-cost/high-volume model runs;
- external writes, sends, posts, deploys, pushes, or publishes;
- sensitive memory commits;
- deleting/forgetting/archive actions with user impact;
- real CAS/Codex execution that can modify files outside the approved package/workspace scope;
- model/provider choices that would expose private or secret context externally.

## Selection record

Future implementation should record model choices as audit-friendly events:

```json
{
  "schema": "openclaw.agent.model_selection.v1",
  "event_id": "model_selection_...",
  "created_at": "2026-05-10T00:00:00.000Z",
  "agent_id": "agent.software_engineer",
  "task_kind": "code_implementation",
  "complexity": "medium",
  "risk": "medium",
  "selected_profile": "specialist_coding",
  "selected_model_alias": "codex-default",
  "reasoning_effort": "medium",
  "fallback_profiles": ["deep_reasoning", "balanced"],
  "approval_required": false,
  "reason": "Medium implementation task should use CAS implementer plus reviewer."
}
```

## Phase 2 implementation target

A stub-safe implementation can add:

- model profile schema;
- model profile config;
- deterministic profile selector;
- CAS team-sizing helper;
- model-selection audit records;
- tests for role/task/complexity/risk routing.

It must not change actual OpenClaw runtime model configuration until separately approved.
