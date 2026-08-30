import type { AdapterDispatchResult, MeshTransportAdapter } from "./adapter.js";
import type { AgentSessionRegistry } from "./agent-session-provider.js";
import type { DeliveryRecord } from "../schema/delivery.js";
import type { AgentMessageEnvelopeV1 } from "../schema/envelope.js";

export class AgentSessionTransportAdapter implements MeshTransportAdapter {
  readonly id = "agent-session-transport";
  private readonly registry: AgentSessionRegistry;

  constructor(registry: AgentSessionRegistry) {
    this.registry = registry;
  }

  async dispatch(delivery: DeliveryRecord, envelope: AgentMessageEnvelopeV1): Promise<AdapterDispatchResult> {
    const sessionId = envelope.metadata?.session_id;
    const correlation = {
      trace_id: envelope.trace_id ?? null,
      correlation_id: envelope.correlation_id ?? null,
      causation_id: envelope.causation_id ?? null,
      session_id: typeof sessionId === "string" ? sessionId : null,
      target_agent_id: delivery.target_agent_id
    };
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return { status: "failed", details: { reason: "session_id_missing", ...correlation } };
    }
    if (!this.registry.has(delivery.target_agent_id)) {
      return { status: "failed", details: { reason: "session_provider_missing", ...correlation } };
    }
    try {
      const result = await this.registry.send(delivery.target_agent_id, {
        sessionId,
        workspaceId: envelope.workspace_id,
        message: renderPrompt(envelope),
        messageId: envelope.message_id,
        contextId: envelope.conversation_id,
        ...(typeof envelope.task_id === "string" ? { taskId: envelope.task_id } : {}),
        ...(typeof envelope.correlation_id === "string" ? { correlationId: envelope.correlation_id } : {}),
        idempotencyKey: envelope.idempotency_key
      });
      if (!result.ok) return { status: "failed", details: { reason: result.error ?? "session_send_failed", ...correlation } };
      return {
        status: "delivered",
        details: {
          ...correlation,
          ...(result.reply === undefined ? {} : { reply: result.reply }),
          ...(result.result_error_code === undefined ? {} : {
            result_error_code: result.result_error_code,
            result_error: result.error ?? result.result_error_code
          })
        }
      };
    } catch (error) {
      return {
        status: "failed",
        details: { reason: error instanceof Error ? error.message : String(error), ...correlation }
      };
    }
  }
}

function renderPrompt(envelope: AgentMessageEnvelopeV1): string {
  const content = envelope.content as Record<string, unknown>;
  if (typeof content.text === "string" && content.text.length > 0) return content.text;
  if (typeof content.summary === "string" && content.summary.length > 0) return content.summary;
  return JSON.stringify(content);
}
