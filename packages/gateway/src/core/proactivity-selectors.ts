import {
  PROACTIVITY_RECORD_SCHEMA,
  type ProactivityActionKind,
  type ProactivityApprovalPolicy,
  type ProactivityBacklogOutcome,
  type ProactivityRecord,
  type ProactivityRiskLevel
} from "../schema/proactivity.js";
import type { JsonObject } from "../schema/validation.js";
import { isoNow, type StoreClock } from "./ndjson-store.js";

export interface StaleBacklogItem {
  id: string;
  title: string;
  workspace_id: string;
  domain_id: string;
  project_id?: string | null;
  task_id?: string | null;
  agent_id?: string;
  memory_policy_scope?: string;
  owner_agent_id?: string | null;
  stale_since: string;
  blocked_by?: string | null;
  low_value?: boolean;
  no_longer_relevant?: boolean;
  sensitive?: boolean;
  metadata?: JsonObject;
}

export interface StaleBacklogSelectorOptions {
  clock?: StoreClock;
  defaultAgentId?: string;
}

const DEFAULT_AGENT_ID = "agent.chief_of_staff";

export function selectStaleBacklogProposals(
  items: readonly StaleBacklogItem[],
  options: StaleBacklogSelectorOptions = {}
): ProactivityRecord[] {
  return items.map((item) => {
    const classification = classifyStaleBacklogItem(item);
    const createdAt = isoNow(options.clock);
    const agentId = item.agent_id ?? options.defaultAgentId ?? DEFAULT_AGENT_ID;

    return {
      schema: PROACTIVITY_RECORD_SCHEMA,
      event_id: `proactivity_stale_${stableIdPart(item.id)}`,
      created_at: createdAt,
      workspace_id: item.workspace_id,
      domain_id: item.domain_id,
      ...(item.project_id !== undefined ? { project_id: item.project_id } : {}),
      ...(item.task_id !== undefined ? { task_id: item.task_id } : {}),
      agent_id: agentId,
      trigger_kind: "staleness",
      loop_kind: "operational",
      proposed_action_kind: classification.action,
      risk_level: classification.riskLevel,
      approval_policy: classification.approvalPolicy,
      memory_policy_scope: item.memory_policy_scope ?? item.domain_id,
      no_external_execution: true,
      summary: classification.summary,
      backlog_outcome: classification.outcome,
      metadata: {
        stale_backlog_item_id: item.id,
        stale_since: item.stale_since,
        title: item.title,
        ...(item.owner_agent_id !== undefined ? { owner_agent_id: item.owner_agent_id } : {}),
        ...(item.blocked_by !== undefined ? { blocked_by: item.blocked_by } : {}),
        ...(item.low_value !== undefined ? { low_value: item.low_value } : {}),
        ...(item.no_longer_relevant !== undefined
          ? { no_longer_relevant: item.no_longer_relevant }
          : {}),
        ...(item.sensitive !== undefined ? { sensitive: item.sensitive } : {}),
        ...(item.metadata !== undefined ? { item_metadata: item.metadata } : {})
      }
    };
  });
}

function classifyStaleBacklogItem(item: StaleBacklogItem): {
  action: ProactivityActionKind;
  outcome: ProactivityBacklogOutcome;
  approvalPolicy: ProactivityApprovalPolicy;
  riskLevel: ProactivityRiskLevel;
  summary: string;
} {
  if (item.blocked_by !== undefined && item.blocked_by !== null && item.blocked_by !== "") {
    return {
      action: "escalate",
      outcome: "escalate",
      approvalPolicy: item.sensitive === true ? "ask" : "notify",
      riskLevel: item.sensitive === true ? "medium" : "low",
      summary: `Escalate stale backlog item "${item.title}" blocked by ${item.blocked_by}.`
    };
  }

  if (item.low_value === true || item.no_longer_relevant === true) {
    return {
      action: "archive_proposal",
      outcome: "drop",
      approvalPolicy: "ask",
      riskLevel: item.sensitive === true ? "medium" : "low",
      summary: `Propose archiving stale backlog item "${item.title}".`
    };
  }

  return {
    action: "triage",
    outcome: item.owner_agent_id === undefined || item.owner_agent_id === null ? "decide" : "do",
    approvalPolicy: item.sensitive === true ? "ask" : "none",
    riskLevel: item.sensitive === true ? "medium" : "low",
    summary: `Triage stale backlog item "${item.title}" and choose the next explicit outcome.`
  };
}

function stableIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
