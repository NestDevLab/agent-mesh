import type { AdapterDispatchResult, MeshTransportAdapter } from "./adapter.js";
import type { DeliveryRecord } from "../schema/delivery.js";
import type { AgentMessageEnvelopeV1 } from "../schema/envelope.js";
import { evaluateAntiLoop } from "../core/anti-loop.js";
import { isoNow, newEventId, type StoreClock } from "../core/ndjson-store.js";
import {
  TmuxDispatchStore,
  type TmuxDispatchRecord
} from "../core/tmux-dispatch-store.js";

export interface TmuxSendInput {
  target_agent_id: string;
  tmux_target: string;
  prompt: string;
  message_id: string;
  idempotency_key: string;
}

export interface TmuxSendResult {
  ok: boolean;
  reply?: string;
  error?: string;
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
}

export interface TmuxTransportAdapterOptions {
  sender: TmuxSessionSender;
  routes: readonly TmuxRoute[];
  stateDir?: string;
  clock?: StoreClock;
  history?: readonly AgentMessageEnvelopeV1[];
  maxRepliesPerConversation?: number;
}

export class TmuxTransportAdapter implements MeshTransportAdapter {
  readonly id = "tmux-transport";

  private readonly sender: TmuxSessionSender;
  private readonly routes: readonly TmuxRoute[];
  private readonly store: TmuxDispatchStore;
  private readonly clock?: StoreClock;
  private readonly history?: readonly AgentMessageEnvelopeV1[];
  private readonly maxRepliesPerConversation?: number;

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

    // 3. Idempotency dedup.
    const prior = (
      await this.store.listByIdempotencyKey(envelope.idempotency_key)
    ).find((candidate) => candidate.status !== "failed");
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

    // 6. Real send through the injected sender.
    let result: TmuxSendResult;
    try {
      result = await this.sender.send({
        target_agent_id: delivery.target_agent_id,
        tmux_target: route.tmux_target,
        prompt,
        message_id: envelope.message_id,
        idempotency_key: envelope.idempotency_key
      });
    } catch (error) {
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
        details: { reason, ...correlation }
      };
    }

    const status = result.ok ? "delivered" : "failed";
    const reason = result.ok ? "delivered" : result.error ?? "send_failed";
    const record = await this.record(
      delivery,
      envelope,
      route.tmux_target,
      status,
      true,
      reason
    );

    return {
      status,
      external_id: record.id,
      details: {
        tmux_target: route.tmux_target,
        ...(result.reply !== undefined ? { reply: result.reply } : {}),
        ...correlation
      }
    };
  }

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
