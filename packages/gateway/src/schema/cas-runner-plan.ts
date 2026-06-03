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

export const CAS_RUNNER_PLAN_SCHEMA = "openclaw.agent.cas_runner_plan.v1" as const;

export const CAS_RUNNER_PLAN_STATUSES = ["planned_stub_only", "blocked"] as const;
export type CasRunnerPlanStatus = (typeof CAS_RUNNER_PLAN_STATUSES)[number];

export const CAS_RUNNER_OPERATION_MODES = ["analysis", "code_edit", "test", "review"] as const;
export type CasRunnerOperationMode = (typeof CAS_RUNNER_OPERATION_MODES)[number];

export const CAS_RUNNER_APPROVAL_POLICIES = [
  "not_required_read_only",
  "ask_before_write",
  "ask_before_commit",
  "ask_before_push"
] as const;
export type CasRunnerApprovalPolicy = (typeof CAS_RUNNER_APPROVAL_POLICIES)[number];

export interface CasRunnerPlanRecord {
  schema: typeof CAS_RUNNER_PLAN_SCHEMA;
  id: string;
  execution_job_id: string;
  status: CasRunnerPlanStatus;
  endpoint_id: string;
  workspace_dir: string;
  repo_scope: string;
  thread_name: string;
  cas_roles: string[];
  operation_mode: CasRunnerOperationMode;
  approval_policy: CasRunnerApprovalPolicy;
  allowed_actions: string[];
  forbidden_actions: string[];
  no_external_side_effects: true;
  no_real_cas_adapter_call: true;
  no_codex_workers_call: true;
  created_at: string;
  reason: string;
  metadata?: JsonObject;
}

export function validateCasRunnerPlanRecord(
  input: unknown
): ValidationResult<CasRunnerPlanRecord> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const schema = requireEnum(input, "schema", [CAS_RUNNER_PLAN_SCHEMA], issues);
  const id = requireString(input, "id", issues);
  const executionJobId = requireString(input, "execution_job_id", issues);
  const status = requireEnum(input, "status", CAS_RUNNER_PLAN_STATUSES, issues);
  const endpointId = requireString(input, "endpoint_id", issues);
  const workspaceDir = requireString(input, "workspace_dir", issues);
  const repoScope = requireString(input, "repo_scope", issues);
  const threadName = requireString(input, "thread_name", issues);
  const casRoles = requiredStringArray(input, "cas_roles", issues);
  const operationMode = requireEnum(
    input,
    "operation_mode",
    CAS_RUNNER_OPERATION_MODES,
    issues
  );
  const approvalPolicy = requireEnum(
    input,
    "approval_policy",
    CAS_RUNNER_APPROVAL_POLICIES,
    issues
  );
  const allowedActions = requiredStringArray(input, "allowed_actions", issues);
  const forbiddenActions = requiredStringArray(input, "forbidden_actions", issues);
  const noExternalSideEffects = requireTrue(input, "no_external_side_effects", issues);
  const noRealCasAdapterCall = requireTrue(input, "no_real_cas_adapter_call", issues);
  const noCodexWorkersCall = requireTrue(input, "no_codex_workers_call", issues);
  const createdAt = requireIsoDateString(input, "created_at", issues);
  const reason = requireString(input, "reason", issues);
  const metadata = optionalJsonObject(input, "metadata", issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({
    schema: schema!,
    id: id!,
    execution_job_id: executionJobId!,
    status: status!,
    endpoint_id: endpointId!,
    workspace_dir: workspaceDir!,
    repo_scope: repoScope!,
    thread_name: threadName!,
    cas_roles: casRoles!,
    operation_mode: operationMode!,
    approval_policy: approvalPolicy!,
    allowed_actions: allowedActions!,
    forbidden_actions: forbiddenActions!,
    no_external_side_effects: noExternalSideEffects!,
    no_real_cas_adapter_call: noRealCasAdapterCall!,
    no_codex_workers_call: noCodexWorkersCall!,
    created_at: createdAt!,
    reason: reason!,
    ...(metadata !== undefined ? { metadata } : {})
  });
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
