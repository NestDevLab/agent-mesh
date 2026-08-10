import { isAbsolute, normalize, sep } from "path";
import type {
  RunnerApprovalPolicy,
  RunnerOperationMode,
  RunnerPlanRecord
} from "../schema/runner-plan.js";
import {
  RUNNER_DISPATCH_RECORD_SCHEMA,
  type RunnerDispatchRecord
} from "../schema/runner-dispatch.js";
import type { PolicyDecisionRecord } from "../schema/policy-decision.js";
import type { JsonObject } from "../schema/validation.js";
import { RunnerDispatchStore } from "../core/runner-dispatch-store.js";
import { isoNow, newEventId, type StoreClock } from "../core/ndjson-store.js";

export interface RunnerDispatchPayload {
  execution_job_id: string;
  plan_id?: string;
  endpoint_id: string;
  workspace_dir: string;
  repo_scope: string;
  thread_name: string;
  runner_roles: string[];
  operation_mode: RunnerOperationMode;
  approval_policy: RunnerApprovalPolicy;
  allowed_actions: string[];
  forbidden_actions: string[];
  metadata?: JsonObject;
}

export interface RunnerDispatcherResult {
  dispatcher_result_id: string;
  status: "dispatched";
  summary: string;
  metadata?: JsonObject;
}

export interface RunnerDispatcher {
  dispatch(payload: RunnerDispatchPayload): Promise<RunnerDispatcherResult>;
}

export interface StrictRunnerDispatchInput extends RunnerDispatchPayload {
  enable_real_dispatch: boolean;
  policy_decision: PolicyDecisionRecord;
}

export interface StrictRunnerDispatchOptions {
  stateDir?: string;
  clock?: StoreClock;
}

export interface StrictRunnerDispatchResult {
  ok: boolean;
  attempt: RunnerDispatchRecord;
  result?: RunnerDispatchRecord;
  dispatcher_result?: RunnerDispatcherResult;
  error?: Error;
}

const PROHIBITED_ACTIONS = [
  "push",
  "publish",
  "deploy",
  "restart",
  "delete",
  "external_message",
  "openclaw_core_edit",
  "real_runner_adapter_call",
  "codex_workers_run_task"
] as const;

export class StrictRunnerDispatchAdapter {
  private readonly dispatcher: RunnerDispatcher;
  private readonly store: RunnerDispatchStore;
  private readonly clock?: StoreClock;

  constructor(dispatcher: RunnerDispatcher, options: StrictRunnerDispatchOptions = {}) {
    this.dispatcher = dispatcher;
    this.store = new RunnerDispatchStore(options);
    this.clock = options.clock;
  }

  async dispatch(input: StrictRunnerDispatchInput): Promise<StrictRunnerDispatchResult> {
    const gate = evaluateDispatchGate(input);
    if (!gate.ok) {
      const attempt = createDispatchRecord(input, {
        kind: "attempt",
        status: "blocked",
        dispatcher_called: false,
        reason: gate.reason,
        clock: this.clock
      });
      await this.store.append(attempt);
      return { ok: false, attempt, error: new Error(gate.reason) };
    }

    const attempt = createDispatchRecord(input, {
      kind: "attempt",
      status: "dispatched",
      dispatcher_called: false,
      reason: "Strict runner adapter accepted the request for injected dispatch.",
      clock: this.clock
    });
    await this.store.append(attempt);

    try {
      const dispatcherResult = await this.dispatcher.dispatch(toPayload(input));
      const result = createDispatchRecord(input, {
        kind: "result",
        status: "dispatched",
        dispatcher_called: true,
        reason: dispatcherResult.summary,
        dispatcher_result_id: dispatcherResult.dispatcher_result_id,
        metadata: dispatcherResult.metadata,
        clock: this.clock
      });
      await this.store.append(result);
      return { ok: true, attempt, result, dispatcher_result: dispatcherResult };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      const result = createDispatchRecord(input, {
        kind: "result",
        status: "failed",
        dispatcher_called: true,
        reason: failure.message,
        clock: this.clock
      });
      await this.store.append(result);
      return { ok: false, attempt, result, error: failure };
    }
  }

  async listRecords(): Promise<RunnerDispatchRecord[]> {
    return this.store.list();
  }
}

export function createStrictDispatchInputFromPlan(
  plan: RunnerPlanRecord,
  input: {
    enable_real_dispatch: boolean;
    policy_decision: PolicyDecisionRecord;
    metadata?: JsonObject;
  }
): StrictRunnerDispatchInput {
  return {
    execution_job_id: plan.execution_job_id,
    plan_id: plan.id,
    endpoint_id: plan.endpoint_id,
    workspace_dir: plan.workspace_dir,
    repo_scope: plan.repo_scope,
    thread_name: plan.thread_name,
    runner_roles: plan.runner_roles,
    operation_mode: plan.operation_mode,
    approval_policy: plan.approval_policy,
    allowed_actions: plan.allowed_actions,
    forbidden_actions: plan.forbidden_actions,
    enable_real_dispatch: input.enable_real_dispatch,
    policy_decision: input.policy_decision,
    metadata: {
      source_plan_schema: plan.schema,
      source_plan_status: plan.status,
      ...(input.metadata ?? {})
    }
  };
}

export function evaluateDispatchGate(input: StrictRunnerDispatchInput): {
  ok: boolean;
  reason: string;
} {
  if (input.enable_real_dispatch !== true) {
    return { ok: false, reason: "Real runner dispatch requires enable_real_dispatch=true." };
  }
  if (input.policy_decision.decision !== "allow-once") {
    return {
      ok: false,
      reason: `Real runner dispatch requires an allow-once policy decision; got ${input.policy_decision.decision}.`
    };
  }
  if (input.policy_decision.subject_id !== input.execution_job_id && input.policy_decision.subject_id !== input.plan_id) {
    return {
      ok: false,
      reason: "Real runner dispatch requires a policy decision scoped to this execution job or plan."
    };
  }
  if (!isScopedWorkspace(input.workspace_dir, input.repo_scope)) {
    return {
      ok: false,
      reason: "Real runner dispatch requires an absolute workspace_dir scoped to repo_scope."
    };
  }
  if (input.allowed_actions.length === 0 || input.forbidden_actions.length === 0) {
    return {
      ok: false,
      reason: "Real runner dispatch requires explicit non-empty allowed_actions and forbidden_actions."
    };
  }
  const allowedProhibited = findProhibitedAction(input.allowed_actions);
  if (allowedProhibited !== undefined) {
    return {
      ok: false,
      reason: `Real runner dispatch cannot allow prohibited action: ${allowedProhibited}.`
    };
  }
  const missingForbidden = PROHIBITED_ACTIONS.find(
    (action) => !input.forbidden_actions.includes(action)
  );
  if (missingForbidden !== undefined) {
    return {
      ok: false,
      reason: `Real runner dispatch requires forbidden_actions to include ${missingForbidden}.`
    };
  }
  if (isWriteCapable(input) && input.approval_policy === "not_required_read_only") {
    return {
      ok: false,
      reason: "Real runner dispatch for write-capable jobs requires at least ask_before_write."
    };
  }
  return { ok: true, reason: "Real runner dispatch gates passed." };
}

function createDispatchRecord(
  input: StrictRunnerDispatchInput,
  options: {
    kind: "attempt" | "result";
    status: "blocked" | "dispatched" | "failed";
    dispatcher_called: boolean;
    reason: string;
    dispatcher_result_id?: string;
    metadata?: JsonObject;
    clock?: StoreClock;
  }
): RunnerDispatchRecord {
  return {
    schema: RUNNER_DISPATCH_RECORD_SCHEMA,
    id: newEventId("runner_dispatch"),
    kind: options.kind,
    execution_job_id: input.execution_job_id,
    ...(input.plan_id !== undefined ? { plan_id: input.plan_id } : {}),
    status: options.status,
    enable_real_dispatch: input.enable_real_dispatch,
    endpoint_id: input.endpoint_id,
    workspace_dir: input.workspace_dir,
    repo_scope: input.repo_scope,
    policy_decision_id: input.policy_decision.decision_id,
    policy_decision: input.policy_decision.decision,
    approval_policy: input.approval_policy,
    allowed_actions: input.allowed_actions,
    forbidden_actions: input.forbidden_actions,
    dispatcher_called: options.dispatcher_called,
    created_at: isoNow(options.clock),
    reason: options.reason,
    ...(options.dispatcher_result_id !== undefined
      ? { dispatcher_result_id: options.dispatcher_result_id }
      : {}),
    metadata: {
      adapter: "strict-runner-dispatch-adapter",
      no_direct_openclaw_tool_call: true,
      no_direct_codex_workers_call: true,
      ...(input.metadata ?? {}),
      ...(options.metadata ?? {})
    }
  };
}

function toPayload(input: StrictRunnerDispatchInput): RunnerDispatchPayload {
  return {
    execution_job_id: input.execution_job_id,
    ...(input.plan_id !== undefined ? { plan_id: input.plan_id } : {}),
    endpoint_id: input.endpoint_id,
    workspace_dir: input.workspace_dir,
    repo_scope: input.repo_scope,
    thread_name: input.thread_name,
    runner_roles: input.runner_roles,
    operation_mode: input.operation_mode,
    approval_policy: input.approval_policy,
    allowed_actions: input.allowed_actions,
    forbidden_actions: input.forbidden_actions,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {})
  };
}

function isScopedWorkspace(workspaceDir: string, repoScope: string): boolean {
  const normalized = normalize(workspaceDir);
  if (!isAbsolute(normalized)) {
    return false;
  }
  if (repoScope === "none" || repoScope.trim().length === 0 || repoScope.includes("..")) {
    return false;
  }
  return normalized.split(sep).filter(Boolean).includes(repoScope);
}

function findProhibitedAction(actions: string[]): string | undefined {
  return actions.find((action) =>
    PROHIBITED_ACTIONS.some((prohibited) => action.toLowerCase() === prohibited)
  );
}

function isWriteCapable(input: StrictRunnerDispatchInput): boolean {
  if (input.operation_mode === "code_edit") {
    return true;
  }
  return input.allowed_actions.some((action) =>
    /edit|write|commit|push|publish|deploy|restart|external/i.test(action)
  );
}
