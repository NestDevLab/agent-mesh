import {
  fail,
  isRecord,
  ok,
  optionalJsonObject,
  optionalStringOrNull,
  requireEnum,
  requireIsoDateString,
  requireString,
  type JsonObject,
  type ValidationIssue,
  type ValidationResult
} from "./validation.js";

export const PROACTIVITY_RECORD_SCHEMA = "openclaw.agent.proactivity.v1" as const;
export const PROACTIVITY_DECISION_SCHEMA = "openclaw.agent.proactivity.decision.v1" as const;
export const PROACTIVITY_OUTCOME_SCHEMA = "openclaw.agent.proactivity.outcome.v1" as const;

export const PROACTIVITY_TRIGGER_KINDS = [
  "scheduled",
  "heartbeat",
  "staleness",
  "failure_pattern",
  "inbox_signal",
  "human_request",
  "post_outcome_review"
] as const;
export type ProactivityTriggerKind = (typeof PROACTIVITY_TRIGGER_KINDS)[number];

export const PROACTIVITY_LOOP_KINDS = ["operational", "improvement"] as const;
export type ProactivityLoopKind = (typeof PROACTIVITY_LOOP_KINDS)[number];

export const PROACTIVITY_ACTION_KINDS = [
  "triage",
  "summarize",
  "prioritize",
  "split",
  "merge",
  "archive_proposal",
  "escalate",
  "handoff",
  "checklist_update_proposal",
  "playbook_update_proposal",
  "memory_proposal",
  "execution_job_proposal",
  "research_proposal",
  "security_review_proposal",
  "backoffice_review_proposal",
  "design_review_proposal"
] as const;
export type ProactivityActionKind = (typeof PROACTIVITY_ACTION_KINDS)[number];

export const PROACTIVITY_BACKLOG_OUTCOMES = [
  "do",
  "defer",
  "delegate",
  "drop",
  "decide",
  "automate",
  "escalate"
] as const;
export type ProactivityBacklogOutcome = (typeof PROACTIVITY_BACKLOG_OUTCOMES)[number];

export const PROACTIVITY_RISK_LEVELS = ["low", "medium", "high"] as const;
export type ProactivityRiskLevel = (typeof PROACTIVITY_RISK_LEVELS)[number];

export const PROACTIVITY_APPROVAL_POLICIES = [
  "none",
  "notify",
  "ask",
  "block_until_approved"
] as const;
export type ProactivityApprovalPolicy = (typeof PROACTIVITY_APPROVAL_POLICIES)[number];

export const PROACTIVITY_DECISIONS = [
  "record_only",
  "allow-once",
  "deny",
  "ask-human"
] as const;
export type ProactivityDecision = (typeof PROACTIVITY_DECISIONS)[number];

export const PROACTIVITY_OUTCOME_STATUSES = [
  "proposed",
  "recorded",
  "blocked_stubbed",
  "requires_human_stubbed"
] as const;
export type ProactivityOutcomeStatus = (typeof PROACTIVITY_OUTCOME_STATUSES)[number];

export interface ProactivityRecord {
  schema: typeof PROACTIVITY_RECORD_SCHEMA;
  event_id: string;
  created_at: string;
  workspace_id: string;
  domain_id: string;
  project_id?: string | null;
  task_id?: string | null;
  agent_id: string;
  trigger_kind: ProactivityTriggerKind;
  loop_kind: ProactivityLoopKind;
  proposed_action_kind: ProactivityActionKind;
  risk_level: ProactivityRiskLevel;
  approval_policy: ProactivityApprovalPolicy;
  memory_policy_scope: string;
  no_external_execution: true;
  summary: string;
  backlog_outcome?: ProactivityBacklogOutcome;
  metadata?: JsonObject;
}

export interface ProactivityDecisionRecord {
  schema: typeof PROACTIVITY_DECISION_SCHEMA;
  decision_id: string;
  event_id: string;
  decision: ProactivityDecision;
  reason: string;
  evaluated_at: string;
  no_external_execution: true;
  metadata?: JsonObject;
}

export interface ProactivityOutcomeRecord {
  schema: typeof PROACTIVITY_OUTCOME_SCHEMA;
  outcome_id: string;
  event_id: string;
  status: ProactivityOutcomeStatus;
  summary: string;
  recorded_at: string;
  no_external_execution: true;
  metadata?: JsonObject;
}

export function validateProactivityRecord(
  input: unknown
): ValidationResult<ProactivityRecord> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const schema = requireLiteral(input, "schema", PROACTIVITY_RECORD_SCHEMA, issues);
  const eventId = requireString(input, "event_id", issues);
  const createdAt = requireIsoDateString(input, "created_at", issues);
  const workspaceId = requireString(input, "workspace_id", issues);
  const domainId = requireString(input, "domain_id", issues);
  const projectId = optionalStringOrNull(input, "project_id", issues);
  const taskId = optionalStringOrNull(input, "task_id", issues);
  const agentId = requireString(input, "agent_id", issues);
  const triggerKind = requireEnum(
    input,
    "trigger_kind",
    PROACTIVITY_TRIGGER_KINDS,
    issues
  );
  const loopKind = requireEnum(input, "loop_kind", PROACTIVITY_LOOP_KINDS, issues);
  const proposedActionKind = requireEnum(
    input,
    "proposed_action_kind",
    PROACTIVITY_ACTION_KINDS,
    issues
  );
  const riskLevel = requireEnum(input, "risk_level", PROACTIVITY_RISK_LEVELS, issues);
  const approvalPolicy = requireEnum(
    input,
    "approval_policy",
    PROACTIVITY_APPROVAL_POLICIES,
    issues
  );
  const memoryPolicyScope = requireString(input, "memory_policy_scope", issues);
  const noExternalExecution = requireTrue(input, "no_external_execution", issues);
  const summary = requireString(input, "summary", issues);
  const backlogOutcome =
    input.backlog_outcome === undefined
      ? undefined
      : requireEnum(input, "backlog_outcome", PROACTIVITY_BACKLOG_OUTCOMES, issues);
  const metadata = optionalJsonObject(input, "metadata", issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({
    schema: schema!,
    event_id: eventId!,
    created_at: createdAt!,
    workspace_id: workspaceId!,
    domain_id: domainId!,
    ...(projectId !== undefined ? { project_id: projectId } : {}),
    ...(taskId !== undefined ? { task_id: taskId } : {}),
    agent_id: agentId!,
    trigger_kind: triggerKind!,
    loop_kind: loopKind!,
    proposed_action_kind: proposedActionKind!,
    risk_level: riskLevel!,
    approval_policy: approvalPolicy!,
    memory_policy_scope: memoryPolicyScope!,
    no_external_execution: noExternalExecution!,
    summary: summary!,
    ...(backlogOutcome !== undefined ? { backlog_outcome: backlogOutcome } : {}),
    ...(metadata !== undefined ? { metadata } : {})
  });
}

export function validateProactivityDecisionRecord(
  input: unknown
): ValidationResult<ProactivityDecisionRecord> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const schema = requireLiteral(input, "schema", PROACTIVITY_DECISION_SCHEMA, issues);
  const decisionId = requireString(input, "decision_id", issues);
  const eventId = requireString(input, "event_id", issues);
  const decision = requireEnum(input, "decision", PROACTIVITY_DECISIONS, issues);
  const reason = requireString(input, "reason", issues);
  const evaluatedAt = requireIsoDateString(input, "evaluated_at", issues);
  const noExternalExecution = requireTrue(input, "no_external_execution", issues);
  const metadata = optionalJsonObject(input, "metadata", issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({
    schema: schema!,
    decision_id: decisionId!,
    event_id: eventId!,
    decision: decision!,
    reason: reason!,
    evaluated_at: evaluatedAt!,
    no_external_execution: noExternalExecution!,
    ...(metadata !== undefined ? { metadata } : {})
  });
}

export function validateProactivityOutcomeRecord(
  input: unknown
): ValidationResult<ProactivityOutcomeRecord> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const schema = requireLiteral(input, "schema", PROACTIVITY_OUTCOME_SCHEMA, issues);
  const outcomeId = requireString(input, "outcome_id", issues);
  const eventId = requireString(input, "event_id", issues);
  const status = requireEnum(input, "status", PROACTIVITY_OUTCOME_STATUSES, issues);
  const summary = requireString(input, "summary", issues);
  const recordedAt = requireIsoDateString(input, "recorded_at", issues);
  const noExternalExecution = requireTrue(input, "no_external_execution", issues);
  const metadata = optionalJsonObject(input, "metadata", issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({
    schema: schema!,
    outcome_id: outcomeId!,
    event_id: eventId!,
    status: status!,
    summary: summary!,
    recorded_at: recordedAt!,
    no_external_execution: noExternalExecution!,
    ...(metadata !== undefined ? { metadata } : {})
  });
}

function requireLiteral<T extends string>(
  input: Record<string, unknown>,
  key: string,
  expected: T,
  issues: ValidationIssue[]
): T | undefined {
  const value = input[key];
  if (value === expected) {
    return expected;
  }
  issues.push({ path: key, message: `must be ${expected}` });
  return undefined;
}

function requireTrue(
  input: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): true | undefined {
  const value = input[key];
  if (value === true) {
    return true;
  }
  issues.push({ path: key, message: "must be true" });
  return undefined;
}
