import type { AuditEvent, AuditFilter } from "../schema/audit.js";
import type { ApprovalGateEvaluation } from "../schema/approval.js";
import type { DeliveryRecord } from "../schema/delivery.js";
import type {
  CodexExecutionJobRequest,
  ExecutionJob,
  ExecutionJobGovernance,
  ExecutionJobStatus
} from "../schema/execution-job.js";
import { validateCodexExecutionJobRequest } from "../schema/execution-job.js";
import type { HeartbeatInput, HeartbeatRecord } from "../schema/heartbeat.js";
import { validateHeartbeatInput } from "../schema/heartbeat.js";
import type {
  AgentMessageEnvelopeV1,
  SubmitEnvelopeInput
} from "../schema/envelope.js";
import { validateAgentMessageEnvelopeV1 } from "../schema/envelope.js";
import type { JsonObject } from "../schema/validation.js";
import { RunnerStubAdapter } from "../adapters/runner-stub-adapter.js";
import { DiscordTranscriptStubAdapter } from "../adapters/discord-transcript-stub-adapter.js";
import { SimulatedAgentAdapter } from "../adapters/simulated-agent-adapter.js";
import type { MeshTransportAdapter } from "../adapters/adapter.js";
import { LocalApprovalGate } from "./approval-gate.js";
import { ApprovalStore } from "./approval-store.js";
import { AgentRegistry } from "./agent-registry.js";
import { AuditStore } from "./audit-store.js";
import type { Clock } from "./clock.js";
import { SystemClock } from "./clock.js";
import { ContextRegistry } from "./context-registry.js";
import { DeadLetterStore } from "./dead-letter-store.js";
import { DeliveryStore } from "./delivery-store.js";
import { EnvelopeStore } from "./envelope-store.js";
import { ExecutionJobStore } from "./execution-job-store.js";
import { GatewayControlStore } from "./gateway-control-store.js";
import { HeartbeatStore } from "./heartbeat-store.js";
import { IdempotencyStore } from "./idempotency-store.js";
import { evaluateAntiLoop } from "./anti-loop.js";
import {
  deriveMeshRoutePolicyConcept,
  describeCorrelationSemantics,
  mapEnvelopeToBridgeAlignedView
} from "./bridge-alignment.js";
import { canonicalInputHash, isoNow, newEventId } from "./ndjson-store.js";

export interface SubmitEnvelopeResult {
  envelope: AgentMessageEnvelopeV1;
  deliveries: DeliveryRecord[];
  auditEventIds: string[];
  duplicate: boolean;
}

export interface AgentMeshGateway {
  submitEnvelope(input: SubmitEnvelopeInput): Promise<SubmitEnvelopeResult>;
  getEnvelope(messageId: string): Promise<AgentMessageEnvelopeV1 | undefined>;
  getDelivery(messageId: string): Promise<DeliveryRecord[]>;
  listAudit(filter?: AuditFilter): Promise<AuditEvent[]>;
  listApprovalEvaluations(): Promise<ApprovalGateEvaluation[]>;
  heartbeat(input: HeartbeatInput): Promise<HeartbeatRecord>;
  createCodexExecutionJobStub(input: CodexExecutionJobRequest): Promise<ExecutionJob>;
}

export interface GatewayServiceOptions {
  stateDir?: string;
  clock?: Clock;
  contextRegistry?: ContextRegistry;
  agentRegistry?: AgentRegistry;
  adapters?: readonly MeshTransportAdapter[];
  paused?: boolean;
  killSwitch?: boolean;
  maxRepliesPerConversation?: number;
  maxDeliveryAttempts?: number;
}

export class GatewayService implements AgentMeshGateway {
  private readonly options: GatewayServiceOptions;
  private readonly clock: Clock;
  private readonly auditStore: AuditStore;
  private readonly approvalStore: ApprovalStore;
  private readonly approvalGate: LocalApprovalGate;
  private readonly deliveryStore: DeliveryStore;
  private readonly deadLetterStore: DeadLetterStore;
  private readonly envelopeStore: EnvelopeStore;
  private readonly executionJobStore: ExecutionJobStore;
  private readonly gatewayControlStore: GatewayControlStore;
  private readonly heartbeatStore: HeartbeatStore;
  private readonly idempotencyStore: IdempotencyStore;
  private readonly adaptersById: Map<string, MeshTransportAdapter>;
  private readonly maxRepliesPerConversation: number;
  private readonly maxDeliveryAttempts: number;
  private paused: boolean;
  private killSwitch: boolean;

  constructor(options: GatewayServiceOptions = {}) {
    this.options = options;
    this.clock = options.clock ?? new SystemClock();
    this.auditStore = new AuditStore({ stateDir: options.stateDir, clock: this.clock });
    this.approvalStore = new ApprovalStore({ stateDir: options.stateDir, clock: this.clock });
    this.approvalGate = new LocalApprovalGate({ stateDir: options.stateDir, clock: this.clock });
    this.deliveryStore = new DeliveryStore({ stateDir: options.stateDir, clock: this.clock });
    this.deadLetterStore = new DeadLetterStore({ stateDir: options.stateDir, clock: this.clock });
    this.envelopeStore = new EnvelopeStore({ stateDir: options.stateDir, clock: this.clock });
    this.executionJobStore = new ExecutionJobStore({
      stateDir: options.stateDir,
      clock: this.clock
    });
    this.gatewayControlStore = new GatewayControlStore({
      stateDir: options.stateDir,
      clock: this.clock
    });
    this.heartbeatStore = new HeartbeatStore({ stateDir: options.stateDir, clock: this.clock });
    this.idempotencyStore = new IdempotencyStore({
      stateDir: options.stateDir,
      clock: this.clock
    });
    this.maxRepliesPerConversation = options.maxRepliesPerConversation ?? 8;
    this.maxDeliveryAttempts = options.maxDeliveryAttempts ?? 1;
    this.paused = options.paused ?? false;
    this.killSwitch = options.killSwitch ?? false;

    const adapters =
      options.adapters ??
      [
        new SimulatedAgentAdapter(),
        new DiscordTranscriptStubAdapter(),
        new RunnerStubAdapter({ stateDir: options.stateDir, clock: this.clock })
      ];
    this.adaptersById = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  }

  static async create(options: GatewayServiceOptions = {}): Promise<GatewayService> {
    const [contextRegistry, agentRegistry] = await Promise.all([
      options.contextRegistry ?? ContextRegistry.fromFile(),
      options.agentRegistry ?? AgentRegistry.fromFile()
    ]);
    const persistedControl = await new GatewayControlStore({
      stateDir: options.stateDir,
      clock: options.clock
    }).current();

    return new GatewayService({
      ...options,
      contextRegistry,
      agentRegistry,
      paused: options.paused ?? persistedControl?.paused,
      killSwitch: options.killSwitch ?? persistedControl?.kill_switch
    });
  }

  async submitEnvelope(input: SubmitEnvelopeInput): Promise<SubmitEnvelopeResult> {
    const validation = validateAgentMessageEnvelopeV1(input);
    if (!validation.ok) {
      await this.appendAudit("envelope.rejected", {
        details: {
          reason: "invalid_envelope",
          issues: validation.issues.map((issue) => ({
            path: issue.path,
            message: issue.message
          }))
        }
      });
      throw new Error(
        `Invalid agent message envelope: ${validation.issues
          .map((issue) => `${issue.path} ${issue.message}`)
          .join("; ")}`
      );
    }

    const envelope = canonicalizeEnvelope(validation.value!);
    const persistenceGuard = evaluatePersistenceGuard(envelope);
    if (!persistenceGuard.accepted) {
      await this.appendAudit("envelope.rejected", {
        details: {
          reason: persistenceGuard.reason,
          message_id: envelope.message_id,
          correlation_id: envelope.correlation_id ?? null
        }
      });
      throw new Error(`Envelope rejected by persistence guard: ${persistenceGuard.reason}`);
    }

    await this.assertGatewayOpen(envelope);
    await this.assertContextAndAgents(envelope);
    await this.assertTerminalReopenAllowed(envelope);

    const history = await this.envelopeStore.list();
    const antiLoop = evaluateAntiLoop(envelope, {
      clock: this.clock,
      history,
      maxRepliesPerConversation: this.maxRepliesPerConversation
    });
    if (!antiLoop.accepted) {
      await this.appendAudit("envelope.rejected", {
        envelope,
        details: { reason: antiLoop.reason ?? "anti_loop_rejected" }
      });
      throw new Error(`Envelope rejected by anti-loop guard: ${antiLoop.reason}`);
    }

    const idempotency = await this.idempotencyStore.checkAndRemember(
      envelope.idempotency_key,
      envelope
    );
    if (idempotency.status === "conflict") {
      await this.appendAudit("envelope.rejected", {
        envelope,
        details: {
          reason: "idempotency_conflict",
          key: idempotency.key,
          existing_hash: idempotency.existing_hash,
          input_hash: idempotency.input_hash
        }
      });
      throw new Error(`Idempotency conflict for key ${idempotency.key}`);
    }

    if (idempotency.status === "duplicate") {
      const audit = await this.appendAudit("envelope.accepted", {
        envelope,
        details: { duplicate: true, idempotency_key: envelope.idempotency_key }
      });
      return {
        envelope,
        deliveries: await this.deliveryStore.listByMessageId(envelope.message_id),
        auditEventIds: [audit.id],
        duplicate: true
      };
    }

    await this.envelopeStore.append(envelope);
    const acceptedAudit = await this.appendAudit("envelope.accepted", {
      envelope,
      details: {
        duplicate: false,
        idempotency_key: envelope.idempotency_key,
        bridge_alignment: mapEnvelopeToBridgeAlignedView(envelope),
        route_policy_concept: deriveMeshRoutePolicyConcept(envelope),
        correlation_semantics: describeCorrelationSemantics(envelope)
      }
    });

    const auditEventIds = [acceptedAudit.id];
    const finalDeliveries: DeliveryRecord[] = [];

    for (const adapter of this.adaptersForEnvelope(envelope)) {
      const queued = this.deliveryRecord(envelope, adapter.id, "queued", 0);
      await this.deliveryStore.append(queued);
      const queuedAudit = await this.appendAudit("delivery.queued", {
        envelope,
        details: {
          delivery_id: queued.id,
          adapter_id: adapter.id,
          target_agent_id: envelope.to
        }
      });
      auditEventIds.push(queuedAudit.id);

      const { delivery: updated, result } = await this.dispatchWithLifecycle(
        queued,
        envelope,
        adapter
      );
      finalDeliveries.push(updated);

      const updatedAudit = await this.appendAudit("delivery.updated", {
        envelope,
        details: {
          delivery_id: updated.id,
          adapter_id: adapter.id,
          status: updated.status,
          external_id: result.external_id ?? null,
          adapter_details: (result.details ?? {}) as JsonObject
        }
      });
      auditEventIds.push(updatedAudit.id);

      if (
        adapter.id === "runner-stub" &&
        typeof result.details?.execution_job_id === "string"
      ) {
        if (typeof result.details.approval_request_id === "string") {
          const approvalRequestedAudit = await this.appendAudit("approval.requested", {
            envelope,
            details: {
              approval_request_id: result.details.approval_request_id,
              execution_job_id: result.details.execution_job_id,
              policy_profile:
                typeof result.details.policy_profile === "string"
                  ? result.details.policy_profile
                  : "",
              approval_profile:
                typeof result.details.approval_profile === "string"
                  ? result.details.approval_profile
                  : "",
              risk_flags: Array.isArray(result.details.approval_risk_flags)
                ? result.details.approval_risk_flags
                : [],
              no_external_execution: true
            }
          });
          auditEventIds.push(approvalRequestedAudit.id);
        }
        if (typeof result.details.approval_decision_id === "string") {
          const approvalDecidedAudit = await this.appendAudit("approval.decided", {
            envelope,
            details: {
              approval_request_id:
                typeof result.details.approval_request_id === "string"
                  ? result.details.approval_request_id
                  : "",
              approval_decision_id: result.details.approval_decision_id,
              execution_job_id: result.details.execution_job_id,
              decision:
                typeof result.details.approval_decision === "string"
                  ? result.details.approval_decision
                  : "",
              reason:
                typeof result.details.approval_reason === "string"
                  ? result.details.approval_reason
                  : "",
              human_escalation_required: result.details.approval_decision === "ask-human",
              no_external_execution: true
            }
          });
          auditEventIds.push(approvalDecidedAudit.id);
        }
        const jobAudit = await this.appendAudit("execution_job.stubbed", {
          envelope,
          details: {
            execution_job_id: result.details.execution_job_id,
            endpoint_id:
              typeof result.details.endpoint_id === "string" ? result.details.endpoint_id : "",
            workspace_dir:
              typeof result.details.workspace_dir === "string"
                ? result.details.workspace_dir
                : "",
            repo_scope:
              typeof result.details.repo_scope === "string" ? result.details.repo_scope : "",
            approval_profile:
              typeof result.details.approval_profile === "string"
                ? result.details.approval_profile
                : "",
            approval_status:
              typeof result.details.approval_status === "string"
                ? result.details.approval_status
                : "",
            governance_decision:
              typeof result.details.governance_decision === "string"
                ? result.details.governance_decision
                : "",
            governance_reason:
              typeof result.details.governance_reason === "string"
                ? result.details.governance_reason
                : "",
            control_intent:
              typeof result.details.control_intent === "string" ? result.details.control_intent : "",
            no_external_execution: true
          }
        });
        auditEventIds.push(jobAudit.id);
      }
    }

    return {
      envelope,
      deliveries: finalDeliveries,
      auditEventIds,
      duplicate: false
    };
  }

  async getDelivery(messageId: string): Promise<DeliveryRecord[]> {
    return this.deliveryStore.listByMessageId(messageId);
  }

  async getEnvelope(messageId: string): Promise<AgentMessageEnvelopeV1 | undefined> {
    return (await this.envelopeStore.list()).find((envelope) => envelope.message_id === messageId);
  }

  async listAudit(filter?: AuditFilter): Promise<AuditEvent[]> {
    return this.auditStore.list(filter);
  }

  async listApprovalEvaluations(): Promise<ApprovalGateEvaluation[]> {
    return this.approvalStore.list();
  }

  async heartbeat(input: HeartbeatInput): Promise<HeartbeatRecord> {
    const validation = validateHeartbeatInput(input);
    if (!validation.ok) {
      throw new Error(
        `Invalid heartbeat input: ${validation.issues
          .map((issue) => `${issue.path} ${issue.message}`)
          .join("; ")}`
      );
    }
    const heartbeat = validation.value!;
    if (!this.agentRegistry().get(heartbeat.agent_id)) {
      throw new Error(`Unknown heartbeat agent: ${heartbeat.agent_id}`);
    }

    const record: HeartbeatRecord = {
      ...heartbeat,
      id: newEventId("heartbeat"),
      observed_at: heartbeat.observed_at ?? isoNow(this.clock)
    };
    await this.heartbeatStore.append(record);
    await this.appendAudit("heartbeat.recorded", {
      details: {
        heartbeat_id: record.id,
        agent_id: record.agent_id,
        status: record.status
      },
      actorId: record.agent_id
    });
    return record;
  }

  async createCodexExecutionJobStub(
    input: CodexExecutionJobRequest
  ): Promise<ExecutionJob> {
    const validation = validateCodexExecutionJobRequest(input);
    if (!validation.ok) {
      throw new Error(
        `Invalid Codex execution job request: ${validation.issues
          .map((issue) => `${issue.path} ${issue.message}`)
          .join("; ")}`
      );
    }
    const request = validation.value!;
    if (!this.agentRegistry().get(request.requested_by_agent_id)) {
      throw new Error(`Unknown requesting agent: ${request.requested_by_agent_id}`);
    }
    if (!this.contextRegistry().isActive(request.workspace_id)) {
      throw new Error(`Unknown or inactive workspace context: ${request.workspace_id}`);
    }
    if (!this.contextRegistry().isActive(request.domain_id)) {
      throw new Error(`Unknown or inactive domain context: ${request.domain_id}`);
    }

    const now = isoNow(this.clock);
    const jobId = newEventId("execution_job");
    const approval = await this.approvalGate.evaluateExecutionJob(request, jobId);
    const governance = buildStubGovernance(request, now, approval);
    const job: ExecutionJob = {
      id: jobId,
      status: statusForGovernance(governance),
      runner: "codex-stub",
      request,
      governance,
      created_at: now,
      updated_at: now
    };
    await this.executionJobStore.append(job);
    await this.appendAudit("approval.requested", {
      details: {
        approval_request_id: approval.request.id,
        execution_job_id: job.id,
        subject_kind: approval.request.subject_kind,
        policy_profile: approval.request.policy_profile,
        approval_profile: approval.request.approval_profile,
        reviewer_flow: approval.request.reviewer_flow,
        risk_flags: approval.request.risk_flags,
        no_external_execution: true
      },
      actorId: request.requested_by_agent_id
    });
    await this.appendAudit("approval.decided", {
      details: {
        approval_request_id: approval.request.id,
        approval_decision_id: approval.decision.id,
        execution_job_id: job.id,
        decision: approval.decision.decision,
        status: approval.decision.status,
        reason: approval.decision.reason,
        human_escalation_required: approval.decision.human_escalation_required,
        reviewer_flow: approval.decision.reviewer_flow,
        no_external_execution: true
      },
      actorId: request.requested_by_agent_id
    });
    await this.appendAudit("execution_job.stubbed", {
      details: {
        execution_job_id: job.id,
        requested_by_agent_id: request.requested_by_agent_id,
        endpoint_id: request.endpoint_id,
        workspace_dir: request.workspace_dir,
        repo_scope: request.repo_scope,
        approval_profile: request.approval_profile,
        approval_status: governance.approval_status,
        approval_request_id: approval.request.id,
        approval_decision_id: approval.decision.id,
        approval_decision: approval.decision.decision,
        approval_reason: approval.decision.reason,
        governance_decision: governance.decision,
        governance_reason: governance.reason,
        control_intent: request.control_intent ?? "run",
        conversation_id: request.conversation_id ?? null,
        correlation_id: request.correlation_id ?? null,
        source_message_id: request.source_message_id ?? null,
        no_external_execution: true
      },
      actorId: request.requested_by_agent_id
    });
    return job;
  }

  async setPaused(paused: boolean): Promise<void> {
    this.paused = paused;
    await this.persistGatewayControlState();
  }

  async setKillSwitch(enabled: boolean): Promise<void> {
    this.killSwitch = enabled;
    await this.persistGatewayControlState();
  }

  private async persistGatewayControlState(): Promise<void> {
    await this.gatewayControlStore.append({
      paused: this.paused,
      kill_switch: this.killSwitch,
      updated_at: isoNow(this.clock)
    });
  }

  private async assertGatewayOpen(envelope: AgentMessageEnvelopeV1): Promise<void> {
    const reason = this.killSwitch
      ? "kill_switch_enabled"
      : this.paused
        ? "gateway_paused"
        : null;
    if (reason === null) {
      return;
    }

    await this.appendAudit("envelope.rejected", {
      envelope,
      details: { reason }
    });
    throw new Error(`Gateway rejected envelope: ${reason}`);
  }

  private async assertContextAndAgents(envelope: AgentMessageEnvelopeV1): Promise<void> {
    const contexts = this.contextRegistry();
    const agents = this.agentRegistry();

    if (!contexts.isActive(envelope.workspace_id)) {
      await this.rejectEnvelope(envelope, "unknown_or_inactive_workspace_context");
      throw new Error(`Unknown or inactive workspace context: ${envelope.workspace_id}`);
    }
    if (!contexts.isActive(envelope.domain_id)) {
      await this.rejectEnvelope(envelope, "unknown_or_inactive_domain_context");
      throw new Error(`Unknown or inactive domain context: ${envelope.domain_id}`);
    }
    if (!agents.get(envelope.from)) {
      await this.rejectEnvelope(envelope, "unknown_source_agent");
      throw new Error(`Unknown source agent: ${envelope.from}`);
    }
    if (!agents.get(envelope.to)) {
      await this.rejectEnvelope(envelope, "unknown_target_agent");
      throw new Error(`Unknown target agent: ${envelope.to}`);
    }
    if (!agents.isPhase1Enabled(envelope.to)) {
      await this.rejectEnvelope(envelope, "target_agent_not_phase_1_enabled");
      throw new Error(`Target agent is not enabled for Phase 1: ${envelope.to}`);
    }
    if (!agents.isEnabledForContext(envelope.from, envelope.domain_id, envelope.workspace_id)) {
      await this.rejectEnvelope(envelope, "source_agent_not_enabled_for_context");
      throw new Error(`Source agent is not enabled for context: ${envelope.from}`);
    }
    if (!agents.isEnabledForContext(envelope.to, envelope.domain_id, envelope.workspace_id)) {
      await this.rejectEnvelope(envelope, "target_agent_not_enabled_for_context");
      throw new Error(`Target agent is not enabled for context: ${envelope.to}`);
    }
  }

  private async assertTerminalReopenAllowed(envelope: AgentMessageEnvelopeV1): Promise<void> {
    if (!isAgentOnlyTerminalReopen(envelope)) {
      return;
    }

    await this.rejectEnvelope(envelope, "agent_only_terminal_reopen_not_allowed");
    throw new Error("Agent-only message cannot reopen a terminal conversation or task");
  }

  private async rejectEnvelope(envelope: AgentMessageEnvelopeV1, reason: string): Promise<void> {
    await this.appendAudit("envelope.rejected", {
      envelope,
      details: { reason }
    });
  }

  private adaptersForEnvelope(envelope: AgentMessageEnvelopeV1): MeshTransportAdapter[] {
    const ids =
      envelope.intent === "execution_job"
        ? ["discord-transcript-stub", "runner-stub"]
        : ["simulated-agent", "discord-transcript-stub"];

    // Additively activate the tmux transport for agent-to-agent intents, but
    // ONLY when a host has registered it. The default gateway (and all existing
    // tests) never register "tmux-transport", so their selection is unchanged.
    if (
      this.adaptersById.has("tmux-transport") &&
      (envelope.intent === "request" || envelope.intent === "reply")
    ) {
      ids.push("tmux-transport");
    }

    return ids.map((id) => {
      const adapter = this.adaptersById.get(id);
      if (adapter === undefined) {
        throw new Error(`Missing adapter: ${id}`);
      }
      return adapter;
    });
  }

  private deliveryRecord(
    envelope: AgentMessageEnvelopeV1,
    adapterId: string,
    status: DeliveryRecord["status"],
    attempts: number
  ): DeliveryRecord {
    const now = isoNow(this.clock);
    return {
      id: newEventId("delivery"),
      message_id: envelope.message_id,
      adapter_id: adapterId,
      target_agent_id: envelope.to,
      status,
      attempts,
      max_attempts: this.maxDeliveryAttempts,
      created_at: now,
      updated_at: now
    };
  }

  private async dispatchWithLifecycle(
    initial: DeliveryRecord,
    envelope: AgentMessageEnvelopeV1,
    adapter: MeshTransportAdapter
  ): Promise<{
    delivery: DeliveryRecord;
    result: { external_id?: string; details?: Record<string, unknown> };
  }> {
    let current = initial;
    let lastResult: { external_id?: string; details?: Record<string, unknown> } = {};

    while (current.attempts < current.max_attempts) {
      current = await this.transitionDelivery(current, "dispatching", {
        attempts: current.attempts + 1
      });

      const result = await adapter.dispatch(current, envelope);
      lastResult = {
        external_id: result.external_id,
        details: result.details
      };

      if (!isAdapterFinalStatus(result.status)) {
        await this.auditInvalidTransition(current, result.status);
        throw new Error(
          `Invalid delivery transition for ${current.id}: ${current.status} -> ${String(
            result.status
          )}`
        );
      }

      if (result.status !== "failed") {
        return {
          delivery: await this.transitionDelivery(current, result.status),
          result: lastResult
        };
      }

      if (current.attempts >= current.max_attempts) {
        const failed = await this.transitionDelivery(current, "failed", {
          last_error: "adapter reported failure; max attempts exhausted"
        });
        await this.deadLetterDelivery(failed, envelope, "max_attempts_exhausted", {
          adapter_details: (result.details ?? {}) as JsonObject
        });
        return { delivery: failed, result: lastResult };
      }
    }

    const failed = await this.transitionDelivery(current, "failed", {
      last_error: "max attempts exhausted before dispatch"
    });
    await this.deadLetterDelivery(failed, envelope, "max_attempts_exhausted");
    return { delivery: failed, result: lastResult };
  }

  private async transitionDelivery(
    current: DeliveryRecord,
    nextStatus: DeliveryRecord["status"],
    updates: Partial<Pick<DeliveryRecord, "attempts" | "last_error">> = {}
  ): Promise<DeliveryRecord> {
    if (!isValidDeliveryTransition(current.status, nextStatus)) {
      await this.auditInvalidTransition(current, nextStatus);
      throw new Error(
        `Invalid delivery transition for ${current.id}: ${current.status} -> ${nextStatus}`
      );
    }

    const next: DeliveryRecord = {
      ...current,
      status: nextStatus,
      updated_at: isoNow(this.clock),
      ...updates
    };
    await this.deliveryStore.append(next);
    return next;
  }

  private async auditInvalidTransition(
    delivery: DeliveryRecord,
    attemptedStatus: string
  ): Promise<AuditEvent> {
    return this.appendAudit("delivery.invalid_transition", {
      details: {
        delivery_id: delivery.id,
        adapter_id: delivery.adapter_id,
        message_id: delivery.message_id,
        from_status: delivery.status,
        attempted_status: attemptedStatus,
        attempts: delivery.attempts,
        max_attempts: delivery.max_attempts
      },
      actorId: delivery.target_agent_id
    });
  }

  private async deadLetterDelivery(
    delivery: DeliveryRecord,
    envelope: AgentMessageEnvelopeV1,
    reason: string,
    details: JsonObject = {}
  ): Promise<void> {
    const deadLetter = {
      id: newEventId("dead_letter"),
      source_file: "delivery-events.ndjson",
      reason,
      created_at: isoNow(this.clock),
      payload: {
        delivery,
        message_id: envelope.message_id,
        correlation_id: envelope.correlation_id ?? null,
        adapter_id: delivery.adapter_id,
        target_agent_id: delivery.target_agent_id,
        ...details
      }
    };
    await this.deadLetterStore.append(deadLetter);
    await this.appendAudit("delivery.dead_lettered", {
      envelope,
      details: {
        dead_letter_id: deadLetter.id,
        delivery_id: delivery.id,
        adapter_id: delivery.adapter_id,
        status: delivery.status,
        reason,
        attempts: delivery.attempts,
        max_attempts: delivery.max_attempts
      }
    });
  }

  private async appendAudit(
    type: AuditEvent["type"],
    input: {
      envelope?: AgentMessageEnvelopeV1;
      details: JsonObject;
      actorId?: string;
    }
  ): Promise<AuditEvent> {
    const audit: AuditEvent = {
      id: newEventId("audit"),
      type,
      created_at: isoNow(this.clock),
      ...(input.envelope !== undefined ? { message_id: input.envelope.message_id } : {}),
      ...(input.envelope?.correlation_id !== undefined && input.envelope.correlation_id !== null
        ? { correlation_id: input.envelope.correlation_id }
        : {}),
      actor_id: input.actorId ?? input.envelope?.from,
      details: input.details
    };
    await this.auditStore.append(audit);
    return audit;
  }

  private contextRegistry(): ContextRegistry {
    return this.options.contextRegistry ?? new ContextRegistry();
  }

  private agentRegistry(): AgentRegistry {
    return this.options.agentRegistry ?? new AgentRegistry();
  }
}

function isAdapterFinalStatus(status: string): status is "delivered" | "failed" | "stubbed" | "waiting_capacity" {
  return status === "delivered" || status === "failed" || status === "stubbed" || status === "waiting_capacity";
}

function isValidDeliveryTransition(
  from: DeliveryRecord["status"],
  to: DeliveryRecord["status"]
): boolean {
  const allowed: Record<DeliveryRecord["status"], readonly DeliveryRecord["status"][]> = {
    queued: ["dispatching", "expired"],
    dispatching: ["dispatching", "delivered", "failed", "stubbed", "expired", "waiting_capacity"],
    delivered: [],
    failed: [],
    expired: [],
    stubbed: [],
    waiting_capacity: ["dispatching", "delivered", "failed", "expired"]
  };
  return allowed[from].includes(to);
}

function canonicalizeEnvelope(envelope: AgentMessageEnvelopeV1): AgentMessageEnvelopeV1 {
  if (envelope.content_hash !== undefined && envelope.content_hash !== null) {
    return envelope;
  }

  return {
    ...envelope,
    content_hash: canonicalInputHash(envelope.content)
  };
}

function buildStubGovernance(
  request: CodexExecutionJobRequest,
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
        ? "runner is stub-only; governance state was recorded without external execution."
        : "runner control intent was recorded by the stub runner without contacting runner.";

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

function evaluatePersistenceGuard(
  envelope: AgentMessageEnvelopeV1
): { accepted: true } | { accepted: false; reason: string } {
  if (envelope.sensitivity === "secret" && envelope.redaction_state !== "redacted") {
    return { accepted: false, reason: "secret_payload_requires_redaction" };
  }

  if (containsObviousSecret(envelope.content) || containsObviousSecret(envelope.metadata ?? {})) {
    return { accepted: false, reason: "obvious_secret_payload_rejected" };
  }

  return { accepted: true };
}

function isAgentOnlyTerminalReopen(envelope: AgentMessageEnvelopeV1): boolean {
  const metadata = envelope.metadata ?? {};
  if (metadata.allow_terminal_reopen === true) {
    return false;
  }

  return (
    metadata.agent_only === true &&
    (metadata.reopens_terminal_conversation === true ||
      metadata.reopens_terminal_task === true)
  );
}

function containsObviousSecret(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsObviousSecret);
  }

  if (value === null || typeof value !== "object") {
    return false;
  }

  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => {
    const normalized = key.toLowerCase();
    if (
      /(api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|private[_-]?key)/.test(
        normalized
      ) &&
      typeof nested === "string" &&
      nested.length > 0 &&
      !/^\[redacted\]$/i.test(nested)
    ) {
      return true;
    }

    return containsObviousSecret(nested);
  });
}
