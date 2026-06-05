# Memory Fabric Policy Gate

## Purpose

The Memory Fabric is the Phase 2 memory design for Agent Mesh. It deliberately avoids a central memory broker by default. Agents share and persist knowledge through explicit, scoped memory targets with provenance, policy classification, and approval-aware proposals.

Discord remains an observable surface only. Memory routing belongs to the mesh gateway and its configured adapters.

## Principles

- No central memory broker unless a concrete coordination failure proves one is needed.
- Every memory action declares workspace, domain, optional project/task, target scope, sensitivity, provenance, and requested writer.
- Agents may read only configured scopes for their role and context.
- Agents propose durable shared writes; they do not silently commit sensitive shared memory.
- Cross-host sharing uses handoff summaries, artifacts, and synced folders.
- Same-host sharing uses local folders and mem0 scopes through OpenClaw configuration and the custom mem0 gateway.
- Sensitive or broad-scope writes require approval before commit.
- All proposals, decisions, target writes, and rejections are audit events.

## Memory targets

| Target | Use | Phase 2 behavior |
| --- | --- | --- |
| `mem0_scope` | Same-host scoped semantic recall/capture | Policy-gated target; no direct unscoped mem0 access. |
| `local_folder` | Same-host durable project/domain notes and artifacts | Allowed only under configured paths/scopes. |
| `memory_wiki` | Curated durable project/person/decision knowledge | Proposal-first; sensitive edits require approval. |
| `synced_folder` | Cross-host handoff via replicated folder/artifact path | Requires provenance and destination context. |
| `prompt_handoff` | Cross-host transfer through summarized prompt/context packet | Always records source, recipient, and redaction state. |

## Scope model

Initial allowed scope families:

```text
workspace.operational_preferences
workspace.personal_private
domain.personal
domain.itermodus
domain.nestdev
domain.domain-alpha
domain.domain-beta
project.*
agent-private.*
```

Scope rules:

- `agent-private.*` is readable only by that logical agent and explicitly approved supervisors.
- `project.*` must include parent domain and project id.
- Domain scopes are limited to agents enabled for that domain.
- `workspace.operational_preferences` is narrow: stable workflow preferences and operating rules only.
- `workspace.personal_private` is private and high-sensitivity by default.

## Policy classification

The policy gate classifies each `memory_proposal` by:

- requested target: `mem0_scope`, `local_folder`, `memory_wiki`, `synced_folder`, or `prompt_handoff`;
- operation: `read`, `propose_write`, `commit_write`, `handoff`, `redact`, `delete_request`;
- sensitivity: `public`, `internal`, `private`, `confidential`, `secret`;
- scope breadth: agent-private, project, domain, workspace;
- source provenance: conversation, artifact, file, tool result, human instruction, derived summary;
- requester role and enabled contexts;
- whether the content contains obvious secret-shaped fields.

## Default decisions

| Condition | Decision |
| --- | --- |
| Unscoped request | `deny` |
| Unknown target/scope | `deny` |
| Agent not enabled for domain/context | `deny` |
| `secret` content without redaction | `deny` |
| Agent-private read/write by owning agent | `allow-once` record-only |
| Same-domain low-sensitivity proposal | `allow-once` proposal-only |
| Durable shared write to wiki/domain/project memory | `ask-human` unless policy explicitly allows |
| Cross-host handoff with private/confidential data | `ask-human` unless redacted and policy allows |
| Delete/forget request | `ask-human` |

`allow-always` is intentionally absent. The automated gate can allow one scoped, audited action or require/deny.

## Memory proposal lifecycle

```text
agent memory_proposal
  -> envelope validation
  -> context/agent registry checks
  -> Memory Fabric policy gate
  -> approval decision: allow-once | deny | ask-human
  -> record proposal and decision
  -> optional target adapter writes only when allowed/approved
  -> append audit event
```

Phase 2 may implement this as a stub-safe local evaluation first. Real mem0/wiki/folder writes must stay disabled until explicitly approved.

## Handoff packet

Cross-host handoffs should use a compact packet:

```json
{
  "schema": "openclaw.memory.handoff.v1",
  "handoff_id": "handoff_...",
  "from_agent_id": "agent.research",
  "to_agent_id": "agent.chief_of_staff",
  "workspace_id": "workspace.the operator",
  "domain_id": "domain.nestdev",
  "project_id": "project.example",
  "summary": "What the receiving agent needs to know.",
  "artifact_refs": [],
  "source_refs": [],
  "sensitivity": "internal",
  "redaction_state": "none",
  "provenance": {
    "source_kind": "conversation|artifact|file|tool_result|human_instruction|derived_summary",
    "source_id": "..."
  }
}
```

## Audit events

The gateway should record at least:

- `memory.proposal.received`
- `memory.policy.evaluated`
- `memory.proposal.denied`
- `memory.proposal.requires_human`
- `memory.proposal.allowed_stubbed`
- `memory.handoff.recorded`
- `memory.target.write_stubbed`

All Phase 2 target writes remain stubbed until a later explicit approval enables real adapters.

## Non-goals for this phase

- No central memory broker.
- No unscoped mem0 access.
- No real cross-host sync setup.
- No real memory-wiki edits from agents.
- No deletion/forget execution.
- No external writes or OpenClaw core changes.
