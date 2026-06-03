import {
  fail,
  isRecord,
  ok,
  optionalJsonObject,
  optionalStringArray,
  requireEnum,
  requireIsoDateString,
  requireString,
  type JsonObject,
  type ValidationIssue,
  type ValidationResult
} from "./validation.js";

export const CAS_RUNNER_DISPATCH_RECORD_SCHEMA =
  "openclaw.agent.cas_runner_dispatch_record.v1" as const;

export const CAS_RUNNER_DISPATCH_RECORD_KINDS = ["attempt", "result"] as const;
export type CasRunnerDispatchRecordKind = (typeof CAS_RUNNER_DISPATCH_RECORD_KINDS)[number];

export const CAS_RUNNER_DISPATCH_STATUSES = ["blocked", "dispatched", "failed"] as const;
export type CasRunnerDispatchStatus = (typeof CAS_RUNNER_DISPATCH_STATUSES)[number];

export interface CasRunnerDispatchRecord {
  schema: typeof CAS_RUNNER_DISPATCH_RECORD_SCHEMA;
  id: string;
  kind: CasRunnerDispatchRecordKind;
  execution_job_id: string;
  plan_id?: string;
  status: CasRunnerDispatchStatus;
  enable_real_dispatch: boolean;
  endpoint_id: string;
  workspace_dir: string;
  repo_scope: string;
  policy_decision_id: string;
  policy_decision: string;
  approval_policy: string;
  allowed_actions: string[];
  forbidden_actions: string[];
  dispatcher_called: boolean;
  created_at: string;
  reason: string;
  dispatcher_result_id?: string;
  metadata?: JsonObject;
}

export function validateCasRunnerDispatchRecord(
  input: unknown
): ValidationResult<CasRunnerDispatchRecord> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const schema = requireEnum(input, "schema", [CAS_RUNNER_DISPATCH_RECORD_SCHEMA], issues);
  const id = requireString(input, "id", issues);
  const kind = requireEnum(input, "kind", CAS_RUNNER_DISPATCH_RECORD_KINDS, issues);
  const executionJobId = requireString(input, "execution_job_id", issues);
  const planId = optionalString(input, "plan_id", issues);
  const status = requireEnum(input, "status", CAS_RUNNER_DISPATCH_STATUSES, issues);
  const enableRealDispatch = requireBoolean(input, "enable_real_dispatch", issues);
  const endpointId = requireString(input, "endpoint_id", issues);
  const workspaceDir = requireString(input, "workspace_dir", issues);
  const repoScope = requireString(input, "repo_scope", issues);
  const policyDecisionId = requireString(input, "policy_decision_id", issues);
  const policyDecision = requireString(input, "policy_decision", issues);
  const approvalPolicy = requireString(input, "approval_policy", issues);
  const allowedActions = requiredStringArray(input, "allowed_actions", issues);
  const forbiddenActions = requiredStringArray(input, "forbidden_actions", issues);
  const dispatcherCalled = requireBoolean(input, "dispatcher_called", issues);
  const createdAt = requireIsoDateString(input, "created_at", issues);
  const reason = requireString(input, "reason", issues);
  const dispatcherResultId = optionalString(input, "dispatcher_result_id", issues);
  const metadata = optionalJsonObject(input, "metadata", issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({
    schema: schema!,
    id: id!,
    kind: kind!,
    execution_job_id: executionJobId!,
    ...(planId !== undefined ? { plan_id: planId } : {}),
    status: status!,
    enable_real_dispatch: enableRealDispatch!,
    endpoint_id: endpointId!,
    workspace_dir: workspaceDir!,
    repo_scope: repoScope!,
    policy_decision_id: policyDecisionId!,
    policy_decision: policyDecision!,
    approval_policy: approvalPolicy!,
    allowed_actions: allowedActions!,
    forbidden_actions: forbiddenActions!,
    dispatcher_called: dispatcherCalled!,
    created_at: createdAt!,
    reason: reason!,
    ...(dispatcherResultId !== undefined ? { dispatcher_result_id: dispatcherResultId } : {}),
    ...(metadata !== undefined ? { metadata } : {})
  });
}

function optionalString(
  input: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): string | undefined {
  if (!Object.hasOwn(input, key)) {
    return undefined;
  }
  const value = input[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  issues.push({ path: key, message: "must be a non-empty string when present" });
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

function requiredStringArray(
  input: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): string[] | undefined {
  const value = optionalStringArray(input, key, issues);
  if (!Object.hasOwn(input, key)) {
    issues.push({ path: key, message: "is required" });
    return undefined;
  }
  if (value !== undefined && value.length === 0) {
    issues.push({ path: key, message: "must not be empty" });
    return undefined;
  }
  return value;
}
