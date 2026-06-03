import {
  fail,
  isRecord,
  ok,
  optionalEnum,
  optionalJsonObject,
  optionalStringOrNull,
  requireEnum,
  requireIsoDateString,
  requireString,
  type JsonObject,
  type ValidationIssue,
  type ValidationResult
} from "./validation.js";
import type { ApprovalGateEvaluation } from "./approval.js";
import { validateApprovalGateEvaluation } from "./approval.js";

export const EXECUTION_JOB_STATUSES = [
  "stubbed",
  "queued",
  "blocked",
  "pause_requested",
  "paused",
  "cancel_requested",
  "canceled",
  "completed",
  "failed"
] as const;

export type ExecutionJobStatus = (typeof EXECUTION_JOB_STATUSES)[number];

export const EXECUTION_JOB_RUNNERS = ["codex-stub"] as const;
export type ExecutionJobRunner = (typeof EXECUTION_JOB_RUNNERS)[number];

export const EXECUTION_JOB_CONTROL_INTENTS = ["run", "pause", "cancel"] as const;
export type ExecutionJobControlIntent = (typeof EXECUTION_JOB_CONTROL_INTENTS)[number];

export const EXECUTION_JOB_GOVERNANCE_DECISIONS = [
  "record_only",
  "blocked_by_policy",
  "pause_requested",
  "cancel_requested"
] as const;
export type ExecutionJobGovernanceDecision =
  (typeof EXECUTION_JOB_GOVERNANCE_DECISIONS)[number];

export const EXECUTION_JOB_APPROVAL_STATUSES = [
  "not_required",
  "required_stubbed",
  "approved_stubbed",
  "denied_stubbed"
] as const;
export type ExecutionJobApprovalStatus =
  (typeof EXECUTION_JOB_APPROVAL_STATUSES)[number];

export interface CodexExecutionJobRequest {
  requested_by_agent_id: string;
  workspace_id: string;
  domain_id: string;
  project_id?: string | null;
  task_id?: string | null;
  conversation_id?: string | null;
  correlation_id?: string | null;
  source_message_id?: string | null;
  control_intent?: ExecutionJobControlIntent;
  summary: string;
  policy_profile: string;
  endpoint_id: string;
  workspace_dir: string;
  repo_scope: string;
  approval_profile: string;
  approval_required?: boolean;
  metadata?: JsonObject;
}

export interface ExecutionJobGovernance {
  decision: ExecutionJobGovernanceDecision;
  policy_profile: string;
  approval_profile: string;
  approval_status: ExecutionJobApprovalStatus;
  approval?: ApprovalGateEvaluation;
  no_external_execution: true;
  reason: string;
  evaluated_at: string;
  workspace_id: string;
  domain_id: string;
  project_id?: string | null;
  task_id?: string | null;
  conversation_id?: string | null;
  correlation_id?: string | null;
  source_message_id?: string | null;
  metadata?: JsonObject;
}

export interface ExecutionJob {
  id: string;
  status: ExecutionJobStatus;
  runner: ExecutionJobRunner;
  request: CodexExecutionJobRequest;
  governance: ExecutionJobGovernance;
  created_at: string;
  updated_at: string;
}

export function validateCodexExecutionJobRequest(
  input: unknown
): ValidationResult<CodexExecutionJobRequest> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const requestedByAgentId = requireString(input, "requested_by_agent_id", issues);
  const workspaceId = requireString(input, "workspace_id", issues);
  const domainId = requireString(input, "domain_id", issues);
  const projectId = optionalStringOrNull(input, "project_id", issues);
  const taskId = optionalStringOrNull(input, "task_id", issues);
  const conversationId = optionalStringOrNull(input, "conversation_id", issues);
  const correlationId = optionalStringOrNull(input, "correlation_id", issues);
  const sourceMessageId = optionalStringOrNull(input, "source_message_id", issues);
  const controlIntent = optionalEnum(
    input,
    "control_intent",
    EXECUTION_JOB_CONTROL_INTENTS,
    issues
  );
  const summary = requireString(input, "summary", issues);
  const policyProfile = requireString(input, "policy_profile", issues);
  const endpointId = requireString(input, "endpoint_id", issues);
  const workspaceDir = requireString(input, "workspace_dir", issues);
  const repoScope = requireString(input, "repo_scope", issues);
  const approvalProfile = requireString(input, "approval_profile", issues);
  const approvalRequired = optionalBoolean(input, "approval_required", issues);
  const metadata = optionalJsonObject(input, "metadata", issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({
    requested_by_agent_id: requestedByAgentId!,
    workspace_id: workspaceId!,
    domain_id: domainId!,
    ...(projectId !== undefined ? { project_id: projectId } : {}),
    ...(taskId !== undefined ? { task_id: taskId } : {}),
    ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
    ...(correlationId !== undefined ? { correlation_id: correlationId } : {}),
    ...(sourceMessageId !== undefined ? { source_message_id: sourceMessageId } : {}),
    ...(controlIntent !== undefined ? { control_intent: controlIntent } : {}),
    summary: summary!,
    policy_profile: policyProfile!,
    endpoint_id: endpointId!,
    workspace_dir: workspaceDir!,
    repo_scope: repoScope!,
    approval_profile: approvalProfile!,
    ...(approvalRequired !== undefined ? { approval_required: approvalRequired } : {}),
    ...(metadata !== undefined ? { metadata } : {})
  });
}

export function validateExecutionJobGovernance(
  input: unknown
): ValidationResult<ExecutionJobGovernance> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const decision = requireEnum(
    input,
    "decision",
    EXECUTION_JOB_GOVERNANCE_DECISIONS,
    issues
  );
  const policyProfile = requireString(input, "policy_profile", issues);
  const approvalProfile = requireString(input, "approval_profile", issues);
  const approvalStatus = requireEnum(
    input,
    "approval_status",
    EXECUTION_JOB_APPROVAL_STATUSES,
    issues
  );
  const approval =
    input.approval === undefined ? undefined : validateApprovalGateEvaluation(input.approval);
  if (approval !== undefined && !approval.ok) {
    for (const issue of approval.issues) {
      issues.push({ path: `approval.${issue.path}`, message: issue.message });
    }
  }
  const noExternalExecution = requireTrue(input, "no_external_execution", issues);
  const reason = requireString(input, "reason", issues);
  const evaluatedAt = requireIsoDateString(input, "evaluated_at", issues);
  const workspaceId = requireString(input, "workspace_id", issues);
  const domainId = requireString(input, "domain_id", issues);
  const projectId = optionalStringOrNull(input, "project_id", issues);
  const taskId = optionalStringOrNull(input, "task_id", issues);
  const conversationId = optionalStringOrNull(input, "conversation_id", issues);
  const correlationId = optionalStringOrNull(input, "correlation_id", issues);
  const sourceMessageId = optionalStringOrNull(input, "source_message_id", issues);
  const metadata = optionalJsonObject(input, "metadata", issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({
    decision: decision!,
    policy_profile: policyProfile!,
    approval_profile: approvalProfile!,
    approval_status: approvalStatus!,
    ...(approval?.value !== undefined ? { approval: approval.value } : {}),
    no_external_execution: noExternalExecution!,
    reason: reason!,
    evaluated_at: evaluatedAt!,
    workspace_id: workspaceId!,
    domain_id: domainId!,
    ...(projectId !== undefined ? { project_id: projectId } : {}),
    ...(taskId !== undefined ? { task_id: taskId } : {}),
    ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
    ...(correlationId !== undefined ? { correlation_id: correlationId } : {}),
    ...(sourceMessageId !== undefined ? { source_message_id: sourceMessageId } : {}),
    ...(metadata !== undefined ? { metadata } : {})
  });
}

export function validateExecutionJob(input: unknown): ValidationResult<ExecutionJob> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const id = requireString(input, "id", issues);
  const status = requireEnum(input, "status", EXECUTION_JOB_STATUSES, issues);
  const runner = requireEnum(input, "runner", EXECUTION_JOB_RUNNERS, issues);
  const requestResult = validateCodexExecutionJobRequest(input.request);
  if (!requestResult.ok) {
    for (const issue of requestResult.issues) {
      issues.push({ path: `request.${issue.path}`, message: issue.message });
    }
  }
  const governanceResult = validateExecutionJobGovernance(input.governance);
  if (!governanceResult.ok) {
    for (const issue of governanceResult.issues) {
      issues.push({ path: `governance.${issue.path}`, message: issue.message });
    }
  }
  const createdAt = requireIsoDateString(input, "created_at", issues);
  const updatedAt = requireIsoDateString(input, "updated_at", issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({
    id: id!,
    status: status!,
    runner: runner!,
    request: requestResult.value!,
    governance: governanceResult.value!,
    created_at: createdAt!,
    updated_at: updatedAt!
  });
}

function optionalBoolean(
  input: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): boolean | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  issues.push({ path: key, message: "must be a boolean" });
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
