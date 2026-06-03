import {
  fail,
  isRecord,
  ok,
  optionalJsonObject,
  optionalStringArray,
  optionalStringOrNull,
  requireEnum,
  requireIsoDateString,
  requireString,
  type JsonObject,
  type ValidationIssue,
  type ValidationResult
} from "./validation.js";

export const APPROVAL_SUBJECT_KINDS = ["execution_job", "memory_action", "tool_action"] as const;
export type ApprovalSubjectKind = (typeof APPROVAL_SUBJECT_KINDS)[number];

export const GUARDIAN_APPROVAL_DECISIONS = ["allow-once", "deny", "ask-human"] as const;
export type GuardianApprovalDecision = (typeof GUARDIAN_APPROVAL_DECISIONS)[number];

export const APPROVAL_REQUEST_STATUSES = [
  "approved_stubbed",
  "denied_stubbed",
  "requires_human_stubbed"
] as const;
export type ApprovalRequestStatus = (typeof APPROVAL_REQUEST_STATUSES)[number];

export interface ApprovalGateRequest {
  id: string;
  subject_kind: ApprovalSubjectKind;
  subject_id: string;
  action: string;
  requested_by_agent_id: string;
  workspace_id: string;
  domain_id: string;
  project_id?: string | null;
  task_id?: string | null;
  conversation_id?: string | null;
  correlation_id?: string | null;
  source_message_id?: string | null;
  policy_profile: string;
  reviewer_flow: string;
  approval_profile: string;
  risk_flags: string[];
  requested_at: string;
  no_external_execution: true;
  metadata?: JsonObject;
}

export interface ApprovalGateDecision {
  id: string;
  request_id: string;
  decision: GuardianApprovalDecision;
  status: ApprovalRequestStatus;
  reason: string;
  policy_profile: string;
  reviewer_flow: string;
  evaluated_at: string;
  no_external_execution: true;
  human_escalation_required: boolean;
  metadata?: JsonObject;
}

export interface ApprovalGateEvaluation {
  request: ApprovalGateRequest;
  decision: ApprovalGateDecision;
}

export function validateApprovalGateRequest(
  input: unknown
): ValidationResult<ApprovalGateRequest> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const id = requireString(input, "id", issues);
  const subjectKind = requireEnum(input, "subject_kind", APPROVAL_SUBJECT_KINDS, issues);
  const subjectId = requireString(input, "subject_id", issues);
  const action = requireString(input, "action", issues);
  const requestedByAgentId = requireString(input, "requested_by_agent_id", issues);
  const workspaceId = requireString(input, "workspace_id", issues);
  const domainId = requireString(input, "domain_id", issues);
  const projectId = optionalStringOrNull(input, "project_id", issues);
  const taskId = optionalStringOrNull(input, "task_id", issues);
  const conversationId = optionalStringOrNull(input, "conversation_id", issues);
  const correlationId = optionalStringOrNull(input, "correlation_id", issues);
  const sourceMessageId = optionalStringOrNull(input, "source_message_id", issues);
  const policyProfile = requireString(input, "policy_profile", issues);
  const reviewerFlow = requireString(input, "reviewer_flow", issues);
  const approvalProfile = requireString(input, "approval_profile", issues);
  const riskFlags = optionalStringArray(input, "risk_flags", issues);
  if (!Object.hasOwn(input, "risk_flags")) {
    issues.push({ path: "risk_flags", message: "is required" });
  }
  const requestedAt = requireIsoDateString(input, "requested_at", issues);
  const noExternalExecution = requireTrue(input, "no_external_execution", issues);
  const metadata = optionalJsonObject(input, "metadata", issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({
    id: id!,
    subject_kind: subjectKind!,
    subject_id: subjectId!,
    action: action!,
    requested_by_agent_id: requestedByAgentId!,
    workspace_id: workspaceId!,
    domain_id: domainId!,
    ...(projectId !== undefined ? { project_id: projectId } : {}),
    ...(taskId !== undefined ? { task_id: taskId } : {}),
    ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
    ...(correlationId !== undefined ? { correlation_id: correlationId } : {}),
    ...(sourceMessageId !== undefined ? { source_message_id: sourceMessageId } : {}),
    policy_profile: policyProfile!,
    reviewer_flow: reviewerFlow!,
    approval_profile: approvalProfile!,
    risk_flags: riskFlags!,
    requested_at: requestedAt!,
    no_external_execution: noExternalExecution!,
    ...(metadata !== undefined ? { metadata } : {})
  });
}

export function validateApprovalGateDecision(
  input: unknown
): ValidationResult<ApprovalGateDecision> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const id = requireString(input, "id", issues);
  const requestId = requireString(input, "request_id", issues);
  const decision = requireEnum(input, "decision", GUARDIAN_APPROVAL_DECISIONS, issues);
  const status = requireEnum(input, "status", APPROVAL_REQUEST_STATUSES, issues);
  const reason = requireString(input, "reason", issues);
  const policyProfile = requireString(input, "policy_profile", issues);
  const reviewerFlow = requireString(input, "reviewer_flow", issues);
  const evaluatedAt = requireIsoDateString(input, "evaluated_at", issues);
  const noExternalExecution = requireTrue(input, "no_external_execution", issues);
  const humanEscalationRequired = requireBoolean(input, "human_escalation_required", issues);
  const metadata = optionalJsonObject(input, "metadata", issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({
    id: id!,
    request_id: requestId!,
    decision: decision!,
    status: status!,
    reason: reason!,
    policy_profile: policyProfile!,
    reviewer_flow: reviewerFlow!,
    evaluated_at: evaluatedAt!,
    no_external_execution: noExternalExecution!,
    human_escalation_required: humanEscalationRequired!,
    ...(metadata !== undefined ? { metadata } : {})
  });
}

export function validateApprovalGateEvaluation(
  input: unknown
): ValidationResult<ApprovalGateEvaluation> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const request = validateApprovalGateRequest(input.request);
  if (!request.ok) {
    for (const issue of request.issues) {
      issues.push({ path: `request.${issue.path}`, message: issue.message });
    }
  }
  const decision = validateApprovalGateDecision(input.decision);
  if (!decision.ok) {
    for (const issue of decision.issues) {
      issues.push({ path: `decision.${issue.path}`, message: issue.message });
    }
  }

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({ request: request.value!, decision: decision.value! });
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

function requireBoolean(
  input: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): boolean | undefined {
  const value = input[key];
  if (typeof value === "boolean") {
    return value;
  }
  issues.push({ path: key, message: "must be a boolean" });
  return undefined;
}
