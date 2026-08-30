import type { AdapterDispatchResult, MeshTransportAdapter } from "./adapter.js";
import type { DeliveryRecord } from "../schema/delivery.js";
import type { AgentMessageEnvelopeV1 } from "../schema/envelope.js";
import { evaluateAntiLoop } from "../core/anti-loop.js";
import { isoNow, newEventId, type StoreClock } from "../core/ndjson-store.js";
import {
  TmuxDispatchStore,
  type TmuxDispatchRecord
} from "../core/tmux-dispatch-store.js";
import { CapacityQueueStore, type CapacityQueueRecord } from "../core/capacity-queue-store.js";
import type { CapacityAdmissionBroker, CapacityAdmissionResult, CapacityRoutePolicy } from "../schema/capacity-admission.js";

export interface TmuxSendInput {
  target_agent_id: string;
  tmux_target: string;
  prompt: string;
  message_id: string;
  context_id: string;
  task_id?: string;
  correlation_id?: string;
  idempotency_key: string;
}

export interface TmuxSendResult {
  ok: boolean;
  reply?: string;
  error?: string;
  result_error_code?: "result_no_output" | "result_uncorrelated" | "result_parsing_failure" | "result_timeout";
}

/**
 * Injected boundary, mirroring DiscordMessageSender. The gateway package never
 * shells out directly; the host wires a real implementation backed by
 * packages/tmux-bridge/bin/agent-send.sh.
 */
export interface TmuxSessionSender {
  send(input: TmuxSendInput): Promise<TmuxSendResult>;
}

export interface TmuxRoute {
  target_agent_id: string;
  tmux_target: string;
  /** Default false => stubbed (dry-run-first, like the Discord adapter). */
  enable_real_send?: boolean;
  /** Default false => MCP-originated prompts cannot enter this tmux session. */
  allow_mcp_ingress?: boolean;
  /** When present, admission is required before a real send. */
  capacity?: CapacityRoutePolicy;
}

export interface TmuxTransportAdapterOptions {
  sender: TmuxSessionSender;
  routes: readonly TmuxRoute[];
  stateDir?: string;
  clock?: StoreClock;
  history?: readonly AgentMessageEnvelopeV1[];
  maxRepliesPerConversation?: number;
  capacityBroker?: CapacityAdmissionBroker;
}

export class TmuxTransportAdapter implements MeshTransportAdapter {
  readonly id = "tmux-transport";

  private readonly sender: TmuxSessionSender;
  private readonly routes: readonly TmuxRoute[];
  private readonly store: TmuxDispatchStore;
  private readonly clock?: StoreClock;
  private readonly history?: readonly AgentMessageEnvelopeV1[];
  private readonly maxRepliesPerConversation?: number;
  private readonly capacityBroker?: CapacityAdmissionBroker;
  private readonly capacityQueue: CapacityQueueStore;

  constructor(options: TmuxTransportAdapterOptions) {
    this.sender = options.sender;
    this.routes = options.routes;
    this.store = new TmuxDispatchStore({
      stateDir: options.stateDir,
      clock: options.clock
    });
    this.clock = options.clock;
    this.history = options.history;
    this.maxRepliesPerConversation = options.maxRepliesPerConversation;
    this.capacityBroker = options.capacityBroker;
    this.capacityQueue = new CapacityQueueStore({ stateDir: options.stateDir, clock: options.clock });
  }

  async dispatch(
    delivery: DeliveryRecord,
    envelope: AgentMessageEnvelopeV1
  ): Promise<AdapterDispatchResult> {
    const correlation = {
      trace_id: envelope.trace_id ?? null,
      correlation_id: envelope.correlation_id ?? null,
      causation_id: envelope.causation_id ?? null,
      target_agent_id: delivery.target_agent_id
    };

    // 1. Anti-loop guard (reused, identical to the Discord path).
    const antiLoop = evaluateAntiLoop(envelope, {
      clock: this.clock,
      history: this.history,
      maxRepliesPerConversation: this.maxRepliesPerConversation
    });
    if (!antiLoop.accepted) {
      const reason = antiLoop.reason ?? "anti_loop_rejected";
      await this.record(delivery, envelope, "", "failed", false, reason);
      return { status: "failed", details: { reason, ...correlation } };
    }

    // 2. Route resolution.
    const route = this.routes.find(
      (candidate) => candidate.target_agent_id === delivery.target_agent_id
    );
    if (route === undefined) {
      const reason = "no_route_for_target";
      await this.record(delivery, envelope, "", "failed", false, reason);
      return { status: "failed", details: { reason, ...correlation } };
    }

    // Public MCP ingress is a separate trust boundary. A real route must opt
    // in explicitly; enabling real sends alone never authorizes web prompts.
    if (envelope.metadata?.ingress === "mcp" && route.allow_mcp_ingress !== true) {
      const reason = "mcp_ingress_not_allowed";
      await this.record(delivery, envelope, route.tmux_target, "failed", false, reason);
      return { status: "failed", details: { reason, tmux_target: route.tmux_target, ...correlation } };
    }

    // 3. Idempotency dedup.
    const prior = (
      await this.store.listByIdempotencyKey(envelope.idempotency_key)
    ).find((candidate) => candidate.status !== "failed" && candidate.status !== "waiting_capacity");
    if (prior !== undefined) {
      return {
        status: prior.status,
        external_id: prior.id,
        details: { deduplicated: true, ...correlation }
      };
    }

    // 4. Render the prompt from the envelope content.
    const prompt = renderPrompt(envelope);

    // 5. Dry-run-first gate.
    if (route.enable_real_send !== true) {
      const record = await this.record(
        delivery,
        envelope,
        route.tmux_target,
        "stubbed",
        false,
        "dry_run_no_real_send"
      );
      return {
        status: "stubbed",
        external_id: record.id,
        details: {
          tmux_target: route.tmux_target,
          prompt_preview: prompt.slice(0, 120),
          ...correlation
        }
      };
    }

    // 6. Capacity admission. Deferred work is durably queued; no prompt is
    // delivered and no TUI state is inspected or synthesized.
    if (route.capacity !== undefined) {
      const admission = await this.admit(route.capacity, envelope);
      if (admission.decision === "defer") {
        const retryAt = admission.retryAt ?? this.nowMs() + (route.capacity.observerRetryMs ?? 60_000);
        await this.queue(delivery, envelope, route.capacity, admission, retryAt, admission.reasons.join(",") || "capacity_deferred");
        const record = await this.record(delivery, envelope, route.tmux_target, "waiting_capacity", false, admission.reasons.join(",") || "capacity_deferred");
        return { status: "waiting_capacity", external_id: record.id, details: { retryAt, decisionId: admission.decisionId, configHash: admission.configHash, workClass: admission.workClass, reasons: admission.reasons, tmux_target: route.tmux_target, ...correlation } };
      }
    }

    // 7. Atomic claim — prevents concurrent same-key dispatches from double
    // sending. The step-3 lookup only catches an already-completed send; this
    // closes the check-then-send window for in-flight concurrency.
    const claimed = await this.store.claim(envelope.idempotency_key);
    if (!claimed) {
      return {
        status: "stubbed",
        details: {
          deduplicated: true,
          reason: "concurrent_dispatch_in_flight",
          tmux_target: route.tmux_target,
          ...correlation
        }
      };
    }

    // 8. Real send through the injected sender.
    let result: TmuxSendResult;
    try {
      result = await this.sender.send({
        target_agent_id: delivery.target_agent_id,
        tmux_target: route.tmux_target,
        prompt,
        message_id: envelope.message_id,
        context_id: envelope.conversation_id,
        ...(typeof envelope.task_id === "string" ? { task_id: envelope.task_id } : {}),
        ...(typeof envelope.correlation_id === "string" ? { correlation_id: envelope.correlation_id } : {}),
        idempotency_key: envelope.idempotency_key
      });
    } catch (error) {
      // Release the claim so a retry of this failed send is allowed.
      await this.store.releaseClaim(envelope.idempotency_key);
      const reason = error instanceof Error ? error.message : String(error);
      const record = await this.record(
        delivery,
        envelope,
        route.tmux_target,
        "failed",
        true,
        reason
      );
      return {
        status: "failed",
        external_id: record.id,
        details: { reason, tmux_target: route.tmux_target, ...correlation }
      };
    }

    const status = result.ok ? "delivered" : "failed";
    const reason = result.ok ? result.result_error_code ?? "delivered" : result.error ?? "send_failed";
    if (status === "failed") {
      // Release the claim so a retry of this failed send is allowed.
      await this.store.releaseClaim(envelope.idempotency_key);
    }
    const record = await this.record(
      delivery,
      envelope,
      route.tmux_target,
      status,
      true,
      reason
    );
    if (status === "delivered") {
      // The delivered record is now the durable dedup source; the claim was only
      // needed to guard the in-flight send window.
      await this.store.releaseClaim(envelope.idempotency_key);
    }
    await this.finishQueued(delivery, envelope, route.capacity, status, reason);

    return {
      status,
      external_id: record.id,
      details: {
        tmux_target: route.tmux_target,
        ...(status === "failed" ? { reason } : {}),
        ...(result.reply !== undefined ? { reply: result.reply } : {}),
        ...(result.result_error_code !== undefined ? { result_error_code: result.result_error_code } : {}),
        ...(result.error !== undefined ? { result_error: result.error } : {}),
        ...correlation
      }
    };
  }

  /** Retry due items. The host schedules calls at the earliest retryAt; this method never sleeps. */
  async drainCapacityQueue(now = this.nowMs(), limit = 32): Promise<AdapterDispatchResult[]> {
    const due = (await this.capacityQueue.waiting(now)).slice(0, Math.max(0, limit));
    const results: AdapterDispatchResult[] = [];
    for (const item of due) results.push(await this.dispatch(item.delivery, item.envelope));
    return results;
  }

  private async admit(policy: CapacityRoutePolicy, envelope: AgentMessageEnvelopeV1): Promise<CapacityAdmissionResult> {
    const workClass = policy.workClass ?? "L1";
    if (!this.capacityBroker) {
      if (workClass === "L1") return { decision: "admit", retryAt: null, decisionId: "broker-unavailable-l1", configHash: "unavailable", workClass, concurrencyTarget: 0, reasons: ["capacity_broker_unavailable_l1_fail_open"] };
      return { decision: "defer", retryAt: this.nowMs() + (policy.observerRetryMs ?? 60_000), decisionId: "broker-unavailable-background", configHash: "unavailable", workClass, concurrencyTarget: 0, reasons: ["capacity_broker_unavailable"] };
    }
    try {
      return await this.capacityBroker.admit({ runId: envelope.idempotency_key, provider: policy.provider, harness: policy.harness, workClass, ...(policy.project ? { project: policy.project } : {}), session: envelope.conversation_id, ...(policy.model ? { model: policy.model } : {}), ...(policy.effort ? { effort: policy.effort } : {}) });
    } catch {
      if (workClass === "L1") return { decision: "admit", retryAt: null, decisionId: "broker-error-l1", configHash: "unavailable", workClass, concurrencyTarget: 0, reasons: ["capacity_broker_error_l1_fail_open"] };
      return { decision: "defer", retryAt: this.nowMs() + (policy.observerRetryMs ?? 60_000), decisionId: "broker-error-background", configHash: "unavailable", workClass, concurrencyTarget: 0, reasons: ["capacity_broker_error"] };
    }
  }

  private async queue(delivery: DeliveryRecord, envelope: AgentMessageEnvelopeV1, route: CapacityRoutePolicy, decision: CapacityAdmissionResult, retryAt: number, reason: string): Promise<void> {
    const previous = (await this.capacityQueue.latest()).find(item => item.idempotency_key === envelope.idempotency_key);
    const record: CapacityQueueRecord = { id: previous?.id ?? `capacity_${envelope.message_id}`, idempotency_key: envelope.idempotency_key, work_class: decision.workClass, status: "waiting_capacity", retry_at: retryAt, attempts: (previous?.attempts ?? 0) + 1, delivery, envelope, route, decision, reason, updated_at: new Date(this.nowMs()).toISOString() };
    await this.capacityQueue.append(record);
  }

  private async finishQueued(delivery: DeliveryRecord, envelope: AgentMessageEnvelopeV1, route: CapacityRoutePolicy | undefined, status: "delivered" | "failed", reason: string): Promise<void> {
    if (!route) return;
    const previous = (await this.capacityQueue.latest()).find(item => item.idempotency_key === envelope.idempotency_key);
    if (!previous) return;
    await this.capacityQueue.append({ ...previous, status: status === "delivered" ? "dispatched" : "failed", retry_at: this.nowMs(), attempts: previous.attempts + 1, delivery, envelope, route, reason, updated_at: new Date(this.nowMs()).toISOString() });
  }

  private nowMs(): number { return this.clock?.now().getTime() ?? Date.now(); }

  private async record(
    delivery: DeliveryRecord,
    envelope: AgentMessageEnvelopeV1,
    tmuxTarget: string,
    status: TmuxDispatchRecord["status"],
    senderCalled: boolean,
    reason: string
  ): Promise<TmuxDispatchRecord> {
    const record: TmuxDispatchRecord = {
      id: newEventId("tmux_dispatch"),
      message_id: envelope.message_id,
      adapter_id: "tmux-transport",
      target_agent_id: delivery.target_agent_id,
      tmux_target: tmuxTarget,
      idempotency_key: envelope.idempotency_key,
      status,
      sender_called: senderCalled,
      reason,
      trace_id: envelope.trace_id ?? null,
      correlation_id: envelope.correlation_id ?? null,
      causation_id: envelope.causation_id ?? null,
      created_at: isoNow(this.clock)
    };
    await this.store.append(record);
    return record;
  }
}

function renderPrompt(envelope: AgentMessageEnvelopeV1): string {
  const content = envelope.content as Record<string, unknown>;
  if (typeof content.text === "string" && content.text.length > 0) {
    return content.text;
  }
  if (typeof content.summary === "string" && content.summary.length > 0) {
    return content.summary;
  }
  return JSON.stringify(content);
}
