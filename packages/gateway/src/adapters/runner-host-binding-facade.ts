import { normalize, sep } from "path";
import type {
  RunnerDispatcher,
  RunnerDispatcherResult,
  RunnerDispatchPayload
} from "./runner-dispatch-adapter.js";
import type { JsonObject } from "../schema/validation.js";

export type HostRunnerInvocationFunction = (
  request: HostRunnerInvocationRequest
) => Promise<HostRunnerInvocationResult>;

export interface HostRunnerBindingFacadeOptions {
  allowNonTempWorkspace?: boolean;
}

export interface HostRunnerInvocationRequest {
  endpointId: string;
  workspaceDir: string;
  threadName: string;
  prompt: string;
  safety: HostRunnerInvocationSafety;
  metadata?: JsonObject;
}

export interface HostRunnerInvocationSafety {
  smokeMode: boolean;
  tempWorkspaceRequired: boolean;
  workspaceOnly: true;
  noPushPublishDeployRestartDelete: true;
  noSecrets: true;
  reportFilesAndTestOutput: true;
  noDirectOpenClawTools: true;
  noCodexWorkersRunTask: true;
  executionJobId: string;
  planId?: string;
  repoScope: string;
  approvalPolicy: string;
  operationMode: string;
  allowedActions: string[];
  forbiddenActions: string[];
}

export interface HostRunnerInvocationResult {
  invocationId: string;
  summary: string;
  metadata?: JsonObject;
}

export const RUNNER_HOST_PROMPT_GUARDRAILS = [
  "workspace-only",
  "no push/publish/deploy/restart/delete",
  "no secrets",
  "report files/test output"
] as const;

export class RunnerHostBindingFacade implements RunnerDispatcher {
  private readonly invoke: HostRunnerInvocationFunction;
  private readonly allowNonTempWorkspace: boolean;

  constructor(invoke: HostRunnerInvocationFunction, options: HostRunnerBindingFacadeOptions = {}) {
    this.invoke = invoke;
    this.allowNonTempWorkspace = options.allowNonTempWorkspace === true;
  }

  async dispatch(payload: RunnerDispatchPayload): Promise<RunnerDispatcherResult> {
    if (!this.allowNonTempWorkspace && !isTempWorkspace(payload.workspace_dir)) {
      throw new Error(
        `runner host binding smoke mode requires workspaceDir under /tmp; got ${payload.workspace_dir}.`
      );
    }

    const request = createHostRunnerInvocationRequest(payload, {
      smokeMode: !this.allowNonTempWorkspace,
      tempWorkspaceRequired: !this.allowNonTempWorkspace
    });
    const result = await this.invoke(request);

    return {
      dispatcher_result_id: result.invocationId,
      status: "dispatched",
      summary: result.summary,
      ...(result.metadata !== undefined ? { metadata: result.metadata } : {})
    };
  }
}

export function createHostRunnerInvocationRequest(
  payload: RunnerDispatchPayload,
  options: { smokeMode?: boolean; tempWorkspaceRequired?: boolean } = {}
): HostRunnerInvocationRequest {
  return {
    endpointId: payload.endpoint_id,
    workspaceDir: payload.workspace_dir,
    threadName: payload.thread_name,
    prompt: createHostRunnerPrompt(payload),
    safety: {
      smokeMode: options.smokeMode !== false,
      tempWorkspaceRequired: options.tempWorkspaceRequired !== false,
      workspaceOnly: true,
      noPushPublishDeployRestartDelete: true,
      noSecrets: true,
      reportFilesAndTestOutput: true,
      noDirectOpenClawTools: true,
      noCodexWorkersRunTask: true,
      executionJobId: payload.execution_job_id,
      ...(payload.plan_id !== undefined ? { planId: payload.plan_id } : {}),
      repoScope: payload.repo_scope,
      approvalPolicy: payload.approval_policy,
      operationMode: payload.operation_mode,
      allowedActions: [...payload.allowed_actions],
      forbiddenActions: [...payload.forbidden_actions]
    },
    metadata: {
      binding: "runner-host-binding-facade",
      no_direct_openclaw_tool_call: true,
      no_direct_codex_workers_run_task: true,
      ...(payload.metadata ?? {})
    }
  };
}

export function createHostRunnerPrompt(payload: RunnerDispatchPayload): string {
  return [
    `runner execution job: ${payload.execution_job_id}`,
    payload.plan_id !== undefined ? `runner plan: ${payload.plan_id}` : undefined,
    `Endpoint: ${payload.endpoint_id}`,
    `Workspace: ${payload.workspace_dir}`,
    `Repo scope: ${payload.repo_scope}`,
    `Thread: ${payload.thread_name}`,
    `Operation mode: ${payload.operation_mode}`,
    `Roles: ${payload.runner_roles.join(", ")}`,
    "",
    "Guardrails:",
    ...RUNNER_HOST_PROMPT_GUARDRAILS.map((guardrail) => `- ${guardrail}`),
    "",
    `Allowed actions: ${payload.allowed_actions.join(", ")}`,
    `Forbidden actions: ${payload.forbidden_actions.join(", ")}`,
    "",
    "Task:",
    String(payload.metadata?.summary ?? "Perform the approved runner task inside the scoped workspace.")
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function isTempWorkspace(workspaceDir: string): boolean {
  const normalized = normalize(workspaceDir);
  return normalized === "/tmp" || normalized.startsWith(`/tmp${sep}`);
}
