import { isAbsolute, normalize, sep } from "path";
import type {
  CasRunnerApprovalPolicy,
  CasRunnerOperationMode,
  CasRunnerPlanRecord
} from "../schema/cas-runner-plan.js";
import { CAS_RUNNER_PLAN_SCHEMA } from "../schema/cas-runner-plan.js";
import type { ExecutionJob } from "../schema/execution-job.js";
import type { JsonObject } from "../schema/validation.js";
import { isoNow, newEventId, type StoreClock } from "./ndjson-store.js";
import { CasRunnerPlanStore } from "./cas-runner-plan-store.js";

export interface CasRunnerPlanInput {
  executionJob: ExecutionJob;
  thread_name: string;
  cas_roles: string[];
  operation_mode: CasRunnerOperationMode;
  approval_policy: CasRunnerApprovalPolicy;
  allowed_actions: string[];
  forbidden_actions?: string[];
  metadata?: JsonObject;
}

export interface CasRunnerPlannerOptions {
  stateDir?: string;
  clock?: StoreClock;
}

export const REQUIRED_CAS_RUNNER_FORBIDDEN_ACTIONS = [
  "openclaw_core_edit",
  "push",
  "publish",
  "deploy",
  "restart",
  "delete",
  "external_message",
  "real_cas_adapter_call",
  "codex_workers_run_task"
] as const;

export class CasRunnerPlanFacade {
  private readonly store: CasRunnerPlanStore;
  private readonly clock?: StoreClock;

  constructor(options: CasRunnerPlannerOptions = {}) {
    this.store = new CasRunnerPlanStore(options);
    this.clock = options.clock;
  }

  async plan(input: CasRunnerPlanInput): Promise<CasRunnerPlanRecord> {
    const plan = createCasRunnerPlan(input, this.clock);
    await this.store.append(plan);
    return plan;
  }

  async listPlans(): Promise<CasRunnerPlanRecord[]> {
    return this.store.list();
  }
}

export function createCasRunnerPlan(
  input: CasRunnerPlanInput,
  clock?: StoreClock
): CasRunnerPlanRecord {
  assertApprovedStubExecutionJob(input.executionJob);
  assertScopedWorkspace(input.executionJob);
  assertApprovalPolicy(input);

  const forbiddenActions = mergeRequiredForbiddenActions(input.forbidden_actions ?? []);
  const now = isoNow(clock);

  return {
    schema: CAS_RUNNER_PLAN_SCHEMA,
    id: newEventId("cas_runner_plan"),
    execution_job_id: input.executionJob.id,
    status: "planned_stub_only",
    endpoint_id: input.executionJob.request.endpoint_id,
    workspace_dir: input.executionJob.request.workspace_dir,
    repo_scope: input.executionJob.request.repo_scope,
    thread_name: input.thread_name,
    cas_roles: input.cas_roles,
    operation_mode: input.operation_mode,
    approval_policy: input.approval_policy,
    allowed_actions: input.allowed_actions,
    forbidden_actions: forbiddenActions,
    no_external_side_effects: true,
    no_real_cas_adapter_call: true,
    no_codex_workers_call: true,
    created_at: now,
    reason:
      "CAS runner plan facade is stub-only; it records dispatch intent without contacting CAS or codex_workers.",
    metadata: {
      source: "cas-runner-plan-facade",
      execution_job_status: input.executionJob.status,
      execution_job_runner: input.executionJob.runner,
      governance_decision: input.executionJob.governance.decision,
      approval_status: input.executionJob.governance.approval_status,
      ...(input.metadata ?? {})
    }
  };
}

function assertApprovedStubExecutionJob(job: ExecutionJob): void {
  if (job.runner !== "codex-stub") {
    throw new Error("CAS runner plan requires a codex-stub execution job.");
  }
  if (job.status !== "stubbed") {
    throw new Error(`CAS runner plan requires a stubbed execution job; got ${job.status}.`);
  }
  if (job.governance.no_external_execution !== true) {
    throw new Error("CAS runner plan requires no_external_execution governance.");
  }
  if (job.governance.decision !== "record_only") {
    throw new Error(
      `CAS runner plan requires record_only governance; got ${job.governance.decision}.`
    );
  }
  if (job.governance.approval_status !== "approved_stubbed") {
    throw new Error(
      `CAS runner plan requires approved_stubbed approval; got ${job.governance.approval_status}.`
    );
  }
}

function assertScopedWorkspace(job: ExecutionJob): void {
  const workspaceDir = normalize(job.request.workspace_dir);
  const repoScope = job.request.repo_scope;

  if (!isAbsolute(workspaceDir)) {
    throw new Error("CAS runner plan requires an absolute workspace_dir.");
  }
  if (repoScope === "none" || repoScope.trim().length === 0 || repoScope.includes("..")) {
    throw new Error("CAS runner plan requires an explicit repo_scope.");
  }

  const pathSegments = workspaceDir.split(sep).filter(Boolean);
  if (!pathSegments.includes(repoScope)) {
    throw new Error("CAS runner plan requires workspace_dir to be scoped to repo_scope.");
  }
}

function assertApprovalPolicy(input: CasRunnerPlanInput): void {
  if (!isWriteCapable(input)) {
    return;
  }
  if (input.approval_policy === "not_required_read_only") {
    throw new Error("Write-capable CAS runner plans require an ask_before_* approval policy.");
  }
}

function isWriteCapable(input: CasRunnerPlanInput): boolean {
  if (input.operation_mode === "code_edit") {
    return true;
  }

  return input.allowed_actions.some((action) =>
    /edit|write|commit|push|publish|deploy|restart|external/i.test(action)
  );
}

function mergeRequiredForbiddenActions(actions: string[]): string[] {
  return Array.from(new Set([...actions, ...REQUIRED_CAS_RUNNER_FORBIDDEN_ACTIONS]));
}
