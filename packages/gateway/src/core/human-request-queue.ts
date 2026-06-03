import type {
  HumanDecision,
  HumanDecisionRecord,
  HumanRequestRecord,
  HumanRequestType,
  HumanRiskLevel
} from "../schema/human-request.js";
import {
  HUMAN_DECISION_SCHEMA,
  HUMAN_REQUEST_SCHEMA,
  validateHumanDecisionRecord,
  validateHumanRequestRecord
} from "../schema/human-request.js";
import { canonicalInputHash, isoNow, newEventId, type StoreClock } from "./ndjson-store.js";

export interface DraftHumanRequestInput {
  task_id: string;
  task_title: string;
  request_type: HumanRequestType;
  priority: "P0" | "P1" | "P2" | "P3";
  owner_agent_id: string;
  canonical_state_ref: string;
  question: string;
  recommendation: {
    option: HumanDecision;
    rationale: string;
  };
  risk: {
    risk_level: HumanRiskLevel;
    approval_triggers: string[];
    side_effects: string[];
  };
  impact_if_unanswered: string;
  allowed_replies?: HumanDecision[];
  discord?: HumanRequestRecord["discord"];
  metadata?: HumanRequestRecord["metadata"];
}

export interface HumanDecisionInput {
  request: HumanRequestRecord;
  decision: HumanDecision;
  decided_by: string;
  decision_text_summary: string;
  approval_scope: HumanDecisionRecord["approval_scope"];
  next_task_state: string;
  state_update_refs: string[];
  metadata?: HumanDecisionRecord["metadata"];
}

export function draftHumanRequest(
  input: DraftHumanRequestInput,
  options: { clock?: StoreClock } = {}
): HumanRequestRecord {
  const now = isoNow(options.clock);
  const record: HumanRequestRecord = {
    schema: HUMAN_REQUEST_SCHEMA,
    request_id: newEventId("hrq"),
    task_id: input.task_id,
    task_title: input.task_title,
    request_type: input.request_type,
    priority: input.priority,
    status: "drafted",
    owner_agent_id: input.owner_agent_id,
    created_at: now,
    updated_at: now,
    canonical_state_ref: input.canonical_state_ref,
    question: input.question,
    recommendation: input.recommendation,
    risk: input.risk,
    impact_if_unanswered: input.impact_if_unanswered,
    allowed_replies: input.allowed_replies ?? ["approve", "deny", "later", "ask_more"],
    idempotency_key: `human_request:${canonicalInputHash({
      task_id: input.task_id,
      question: input.question,
      risk: input.risk,
      request_type: input.request_type
    })}`,
    ...(input.discord !== undefined ? { discord: input.discord } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {})
  };

  const validation = validateHumanRequestRecord(record);
  if (!validation.ok) {
    throw new Error(`Invalid HumanRequestRecord: ${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join(", ")}`);
  }
  return record;
}

export function transitionHumanRequestStatus(
  request: HumanRequestRecord,
  status: HumanRequestRecord["status"],
  options: { clock?: StoreClock } = {}
): HumanRequestRecord {
  const updated: HumanRequestRecord = {
    ...request,
    status,
    updated_at: isoNow(options.clock)
  };
  const validation = validateHumanRequestRecord(updated);
  if (!validation.ok) {
    throw new Error(`Invalid transitioned HumanRequestRecord: ${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join(", ")}`);
  }
  return updated;
}

export function captureHumanDecision(
  input: HumanDecisionInput,
  options: { clock?: StoreClock } = {}
): {
  decision: HumanDecisionRecord;
  request: HumanRequestRecord;
} {
  const now = isoNow(options.clock);
  const requestStatus = requestStatusForDecision(input.decision);
  const updatedRequest = transitionHumanRequestStatus(input.request, requestStatus, options);
  const decision: HumanDecisionRecord = {
    schema: HUMAN_DECISION_SCHEMA,
    decision_id: newEventId("hdec"),
    request_id: input.request.request_id,
    task_id: input.request.task_id,
    decision: input.decision,
    decided_by: input.decided_by,
    decided_at: now,
    decision_text_summary: input.decision_text_summary,
    approval_scope: input.approval_scope,
    next_task_state: input.next_task_state,
    state_update_refs: input.state_update_refs,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {})
  };

  const validation = validateHumanDecisionRecord(decision);
  if (!validation.ok) {
    throw new Error(`Invalid HumanDecisionRecord: ${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join(", ")}`);
  }

  return { decision, request: updatedRequest };
}

function requestStatusForDecision(decision: HumanDecision): HumanRequestRecord["status"] {
  switch (decision) {
    case "approve":
      return "approved";
    case "deny":
      return "denied";
    case "later":
      return "later";
    case "ask_more":
      return "ask_more";
    default:
      return "awaiting_human";
  }
}
