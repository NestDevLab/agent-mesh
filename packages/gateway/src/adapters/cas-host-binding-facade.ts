import { normalize, sep } from "path";
import type {
  CasRunnerDispatcher,
  CasRunnerDispatcherResult,
  CasRunnerDispatchPayload
} from "./cas-runner-dispatch-adapter.js";
import type { JsonObject } from "../schema/validation.js";

export type HostCasInvocationFunction = (
  request: HostCasInvocationRequest
) => Promise<HostCasInvocationResult>;

export interface HostCasBindingFacadeOptions {
  allowNonTempWorkspace?: boolean;
}

export interface HostCasInvocationRequest {
  endpointId: string;
  workspaceDir: string;
  threadName: string;
  prompt: string;
  safety: HostCasInvocationSafety;
  metadata?: JsonObject;
}

export interface HostCasInvocationSafety {
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

export interface HostCasInvocationResult {
  invocationId: string;
  summary: string;
  metadata?: JsonObject;
}

export const CAS_HOST_PROMPT_GUARDRAILS = [
  "workspace-only",
  "no push/publish/deploy/restart/delete",
  "no secrets",
  "report files/test output"
] as const;

export class CasHostBindingFacade implements CasRunnerDispatcher {
  private readonly invoke: HostCasInvocationFunction;
  private readonly allowNonTempWorkspace: boolean;

  constructor(invoke: HostCasInvocationFunction, options: HostCasBindingFacadeOptions = {}) {
    this.invoke = invoke;
    this.allowNonTempWorkspace = options.allowNonTempWorkspace === true;
  }

  async dispatch(payload: CasRunnerDispatchPayload): Promise<CasRunnerDispatcherResult> {
    if (!this.allowNonTempWorkspace && !isTempWorkspace(payload.workspace_dir)) {
      throw new Error(
        `CAS host binding smoke mode requires workspaceDir under /tmp; got ${payload.workspace_dir}.`
      );
    }

    const request = createHostCasInvocationRequest(payload, {
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

export function createHostCasInvocationRequest(
  payload: CasRunnerDispatchPayload,
  options: { smokeMode?: boolean; tempWorkspaceRequired?: boolean } = {}
): HostCasInvocationRequest {
  return {
    endpointId: payload.endpoint_id,
    workspaceDir: payload.workspace_dir,
    threadName: payload.thread_name,
    prompt: createHostCasPrompt(payload),
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
      binding: "cas-host-binding-facade",
      no_direct_openclaw_tool_call: true,
      no_direct_codex_workers_run_task: true,
      ...(payload.metadata ?? {})
    }
  };
}

export function createHostCasPrompt(payload: CasRunnerDispatchPayload): string {
  return [
    `CAS execution job: ${payload.execution_job_id}`,
    payload.plan_id !== undefined ? `CAS runner plan: ${payload.plan_id}` : undefined,
    `Endpoint: ${payload.endpoint_id}`,
    `Workspace: ${payload.workspace_dir}`,
    `Repo scope: ${payload.repo_scope}`,
    `Thread: ${payload.thread_name}`,
    `Operation mode: ${payload.operation_mode}`,
    `Roles: ${payload.cas_roles.join(", ")}`,
    "",
    "Guardrails:",
    ...CAS_HOST_PROMPT_GUARDRAILS.map((guardrail) => `- ${guardrail}`),
    "",
    `Allowed actions: ${payload.allowed_actions.join(", ")}`,
    `Forbidden actions: ${payload.forbidden_actions.join(", ")}`,
    "",
    "Task:",
    String(payload.metadata?.summary ?? "Perform the approved CAS task inside the scoped workspace.")
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function isTempWorkspace(workspaceDir: string): boolean {
  const normalized = normalize(workspaceDir);
  return normalized === "/tmp" || normalized.startsWith(`/tmp${sep}`);
}
