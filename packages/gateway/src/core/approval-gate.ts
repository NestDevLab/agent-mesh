import type {
  ApprovalGateEvaluation,
  ApprovalGateRequest
} from "../schema/approval.js";
import type { CodexExecutionJobRequest } from "../schema/execution-job.js";
import type { JsonObject } from "../schema/validation.js";
import { isoNow, newEventId, type StoreClock } from "./ndjson-store.js";
import { ApprovalStore } from "./approval-store.js";

export interface LocalApprovalGateOptions {
  stateDir?: string;
  clock?: StoreClock;
}

export class LocalApprovalGate {
  private readonly store: ApprovalStore;
  private readonly clock?: StoreClock;

  constructor(options: LocalApprovalGateOptions = {}) {
    this.store = new ApprovalStore(options);
    this.clock = options.clock;
  }

  async evaluateExecutionJob(
    request: CodexExecutionJobRequest,
    subjectId: string
  ): Promise<ApprovalGateEvaluation> {
    const now = isoNow(this.clock);
    const riskFlags = executionJobRiskFlags(request);
    const decision = localDecisionForExecutionJob(request, riskFlags);
    const reviewerFlow =
      decision.decision === "ask-human"
        ? "local-stub-human-review-required"
        : "local-stub-static-policy";
    const approvalRequest: ApprovalGateRequest = {
      id: newEventId("approval_request"),
      subject_kind: "execution_job" as const,
      subject_id: subjectId,
      action: request.control_intent ?? "run",
      requested_by_agent_id: request.requested_by_agent_id,
      workspace_id: request.workspace_id,
      domain_id: request.domain_id,
      ...(request.project_id !== undefined ? { project_id: request.project_id } : {}),
      ...(request.task_id !== undefined ? { task_id: request.task_id } : {}),
      ...(request.conversation_id !== undefined ? { conversation_id: request.conversation_id } : {}),
      ...(request.correlation_id !== undefined ? { correlation_id: request.correlation_id } : {}),
      ...(request.source_message_id !== undefined
        ? { source_message_id: request.source_message_id }
        : {}),
      policy_profile: request.policy_profile,
      reviewer_flow: reviewerFlow,
      approval_profile: request.approval_profile,
      risk_flags: riskFlags,
      requested_at: now,
      no_external_execution: true,
      metadata: approvalMetadata(request)
    };
    const evaluation: ApprovalGateEvaluation = {
      request: approvalRequest,
      decision: {
        id: newEventId("approval_decision"),
        request_id: approvalRequest.id,
        decision: decision.decision,
        status: decision.status,
        reason: decision.reason,
        policy_profile: request.policy_profile,
        reviewer_flow: reviewerFlow,
        evaluated_at: now,
        no_external_execution: true,
        human_escalation_required: decision.decision === "ask-human",
        metadata: {
          guardian_concepts: ["policy_profile", "reviewer_flow", "allow-once", "deny", "ask-human"],
          stub_only: true
        }
      }
    };

    await this.store.append(evaluation);
    return evaluation;
  }
}

function executionJobRiskFlags(request: CodexExecutionJobRequest): string[] {
  const flags = ["execution_job", "cas-runner-stub", "no-external-execution"];
  if (request.approval_required) {
    flags.push("approval-required");
  }
  if ((request.control_intent ?? "run") === "run") {
    flags.push("run-intent");
  } else {
    flags.push("control-intent");
  }
  return flags;
}

function localDecisionForExecutionJob(
  request: CodexExecutionJobRequest,
  riskFlags: string[]
): {
  decision: "allow-once" | "deny" | "ask-human";
  status: "approved_stubbed" | "denied_stubbed" | "requires_human_stubbed";
  reason: string;
} {
  if (request.policy_profile === "deny_all" || request.approval_profile === "deny") {
    return {
      decision: "deny",
      status: "denied_stubbed",
      reason: "Local Guardian stub policy denied this execution job."
    };
  }

  if (riskFlags.includes("approval-required")) {
    return {
      decision: "ask-human",
      status: "requires_human_stubbed",
      reason: "Local Guardian stub requires human approval for this execution job."
    };
  }

  return {
    decision: "allow-once",
    status: "approved_stubbed",
    reason: "Local Guardian stub allows this record-only execution job once."
  };
}

function approvalMetadata(request: CodexExecutionJobRequest): JsonObject {
  return {
    summary: request.summary,
    endpoint_id: request.endpoint_id,
    workspace_dir: request.workspace_dir,
    repo_scope: request.repo_scope,
    original_metadata: request.metadata ?? {}
  };
}
