import type { AdapterDispatchResult, MeshTransportAdapter } from "./adapter.js";
import type { DeliveryRecord } from "../schema/delivery.js";
import type {
  ExecutionJobGovernance,
  ExecutionJobStatus
} from "../schema/execution-job.js";
import type { AgentMessageEnvelopeV1 } from "../schema/envelope.js";
import type { JsonObject } from "../schema/validation.js";
import { LocalApprovalGate } from "../core/approval-gate.js";
import { ExecutionJobStore } from "../core/execution-job-store.js";
import { isoNow, newEventId, type StoreClock } from "../core/ndjson-store.js";

export class CodexRunnerStubAdapter implements MeshTransportAdapter {
  readonly id = "codex-runner-stub";
  private readonly executionJobStore: ExecutionJobStore;
  private readonly approvalGate: LocalApprovalGate;
  private readonly clock?: StoreClock;

  constructor(options: { stateDir?: string; clock?: StoreClock } = {}) {
    this.executionJobStore = new ExecutionJobStore(options);
    this.approvalGate = new LocalApprovalGate(options);
    this.clock = options.clock;
  }

  async dispatch(
    _delivery: DeliveryRecord,
    envelope: AgentMessageEnvelopeV1
  ): Promise<AdapterDispatchResult> {
    const content = envelope.content;
    const request = {
      requested_by_agent_id: envelope.from,
      workspace_id: envelope.workspace_id,
      domain_id: envelope.domain_id,
      ...(nullableStringField(content, "project_id") !== undefined
        ? { project_id: nullableStringField(content, "project_id") }
        : {}),
      ...(envelope.task_id !== undefined ? { task_id: envelope.task_id } : {}),
      conversation_id: envelope.conversation_id,
      ...(envelope.correlation_id !== undefined ? { correlation_id: envelope.correlation_id } : {}),
      source_message_id: envelope.message_id,
      control_intent: controlIntentField(content),
      summary: stringField(content, "summary", `Stub Codex job for ${envelope.message_id}`),
      policy_profile: stringField(content, "policy_profile", "phase_1_stub_only"),
      endpoint_id: stringField(content, "endpoint_id", "cas-stub-local"),
      workspace_dir: stringField(content, "workspace_dir", "/workspace/stub"),
      repo_scope: stringField(content, "repo_scope", "none"),
      approval_profile: stringField(content, "approval_profile", "stub-no-external-actions"),
      approval_required: booleanField(content, "approval_required", false),
      metadata: governanceMetadata(content)
    };
    const now = isoNow(this.clock);
    const jobId = newEventId("execution_job");
    const approval = await this.approvalGate.evaluateExecutionJob(request, jobId);
    const governance = buildStubGovernance(request, now, approval);
    const job = {
      id: jobId,
      status: statusForGovernance(governance),
      runner: "codex-stub" as const,
      request,
      governance,
      created_at: now,
      updated_at: now
    };

    await this.executionJobStore.append(job);

    return {
      status: "stubbed",
      external_id: job.id,
      details: {
        execution_job_id: job.id,
        runner: job.runner,
        endpoint_id: request.endpoint_id,
        workspace_dir: request.workspace_dir,
        repo_scope: request.repo_scope,
        policy_profile: request.policy_profile,
        approval_profile: request.approval_profile,
        approval_status: governance.approval_status,
        approval_request_id: governance.approval?.request.id ?? "",
        approval_decision_id: governance.approval?.decision.id ?? "",
        approval_decision: governance.approval?.decision.decision ?? "",
        approval_reason: governance.approval?.decision.reason ?? "",
        approval_reviewer_flow: governance.approval?.decision.reviewer_flow ?? "",
        approval_risk_flags: governance.approval?.request.risk_flags ?? [],
        governance_decision: governance.decision,
        governance_reason: governance.reason,
        control_intent: request.control_intent,
        no_external_execution: true
      }
    };
  }
}

function stringField(content: JsonObject, key: string, fallback: string): string {
  const value = content[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function nullableStringField(content: JsonObject, key: string): string | null | undefined {
  const value = content[key];
  return typeof value === "string" || value === null ? value : undefined;
}

function booleanField(content: JsonObject, key: string, fallback: boolean): boolean {
  const value = content[key];
  return typeof value === "boolean" ? value : fallback;
}

function controlIntentField(content: JsonObject): "run" | "pause" | "cancel" {
  const value = content.control_intent;
  return value === "pause" || value === "cancel" ? value : "run";
}

function governanceMetadata(content: JsonObject): JsonObject {
  return {
    source: "codex-runner-stub-adapter",
    ...(typeof content.requested_capability === "string"
      ? { requested_capability: content.requested_capability }
      : {})
  };
}

function buildStubGovernance(
  request: {
    workspace_id: string;
    domain_id: string;
    project_id?: string | null;
    task_id?: string | null;
    conversation_id?: string | null;
    correlation_id?: string | null;
    source_message_id?: string | null;
    control_intent?: "run" | "pause" | "cancel";
    policy_profile: string;
    approval_profile: string;
    approval_required?: boolean;
    metadata?: JsonObject;
  },
  now: string,
  approval: ExecutionJobGovernance["approval"]
): ExecutionJobGovernance {
  const decision =
    approval?.decision.decision === "deny"
      ? "blocked_by_policy"
      : request.control_intent === "pause"
        ? "pause_requested"
        : request.control_intent === "cancel"
          ? "cancel_requested"
          : "record_only";
  const reason =
    decision === "blocked_by_policy"
      ? (approval?.decision.reason ?? "Execution job was denied by local approval policy.")
      : decision === "record_only"
        ? "CAS runner is stub-only; governance state was recorded without external execution."
        : "CAS control intent was recorded by the stub runner without contacting CAS.";

  return {
    decision,
    policy_profile: request.policy_profile,
    approval_profile: request.approval_profile,
    approval_status: approvalStatusForDecision(approval),
    ...(approval !== undefined ? { approval } : {}),
    no_external_execution: true,
    reason,
    evaluated_at: now,
    workspace_id: request.workspace_id,
    domain_id: request.domain_id,
    ...(request.project_id !== undefined ? { project_id: request.project_id } : {}),
    ...(request.task_id !== undefined ? { task_id: request.task_id } : {}),
    ...(request.conversation_id !== undefined ? { conversation_id: request.conversation_id } : {}),
    ...(request.correlation_id !== undefined ? { correlation_id: request.correlation_id } : {}),
    ...(request.source_message_id !== undefined
      ? { source_message_id: request.source_message_id }
      : {}),
    ...(request.metadata !== undefined ? { metadata: request.metadata } : {})
  };
}

function approvalStatusForDecision(
  approval: ExecutionJobGovernance["approval"]
): ExecutionJobGovernance["approval_status"] {
  if (approval === undefined) {
    return "not_required";
  }
  if (approval.decision.decision === "deny") {
    return "denied_stubbed";
  }
  if (approval.decision.decision === "ask-human") {
    return "required_stubbed";
  }
  return "approved_stubbed";
}

function statusForGovernance(governance: ExecutionJobGovernance): ExecutionJobStatus {
  if (governance.decision === "pause_requested") {
    return "pause_requested";
  }
  if (governance.decision === "cancel_requested") {
    return "cancel_requested";
  }
  if (governance.decision === "blocked_by_policy") {
    return "blocked";
  }
  return "stubbed";
}
