import { GatewayService } from "../core/gateway-service.js";
import { newEventId } from "../core/ndjson-store.js";

export function describeRequestReplyDemo(): string {
  return "Submits one request and one reply envelope through the simulated local agent and Discord transcript stub adapters.";
}

export async function runRequestReplyDemo(): Promise<Record<string, unknown>> {
  const gateway = await GatewayService.create();
  const runId = newEventId("demo");
  const createdAt = new Date().toISOString();
  const conversationId = `demo-conversation-request-reply-${runId}`;
  const correlationId = `demo-correlation-request-reply-${runId}`;

  const request = await gateway.submitEnvelope({
    schema: "openclaw.agent.message.v1",
    message_id: `demo-request-${runId}`,
    created_at: createdAt,
    workspace_id: "workspace.joseph",
    domain_id: "domain.nestdev",
    conversation_id: conversationId,
    from: "agent.chief_of_staff",
    to: "agent.software_engineer",
    intent: "request",
    ttl: 4,
    hop_count: 0,
    idempotency_key: `demo-request-${runId}`,
    correlation_id: correlationId,
    content: {
      text: "Prepare a Phase 1 stub implementation note."
    },
    metadata: {
      demo: true
    }
  });

  const reply = await gateway.submitEnvelope({
    schema: "openclaw.agent.message.v1",
    message_id: `demo-reply-${runId}`,
    created_at: createdAt,
    workspace_id: "workspace.joseph",
    domain_id: "domain.nestdev",
    conversation_id: conversationId,
    from: "agent.software_engineer",
    to: "agent.chief_of_staff",
    intent: "reply",
    ttl: 3,
    hop_count: 1,
    idempotency_key: `demo-reply-${runId}`,
    correlation_id: correlationId,
    causation_id: request.envelope.message_id,
    content: {
      text: "Stub reply persisted for the Phase 1 request/reply demo."
    },
    metadata: {
      demo: true
    }
  });

  return {
    conversation_id: conversationId,
    request_message_id: request.envelope.message_id,
    reply_message_id: reply.envelope.message_id,
    request_duplicate: request.duplicate,
    reply_duplicate: reply.duplicate,
    request_deliveries: request.deliveries.map((delivery) => ({
      adapter_id: delivery.adapter_id,
      status: delivery.status
    })),
    reply_deliveries: reply.deliveries.map((delivery) => ({
      adapter_id: delivery.adapter_id,
      status: delivery.status
    })),
    audit_events_written: request.auditEventIds.length + reply.auditEventIds.length
  };
}
