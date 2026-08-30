import assert from "node:assert/strict";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const { AgentSessionTransportAdapter } = await import(
  "../src/adapters/agent-session-transport-adapter.ts"
);

function envelope(overrides = {}) {
  return {
    schema: "openclaw.agent.message.v1",
    message_id: "message-1",
    created_at: "2026-08-30T12:00:00.000Z",
    workspace_id: "workspace.allowed",
    domain_id: "domain.allowed",
    conversation_id: "context-1",
    from: "agent.web",
    to: "agent.ingress.codex",
    intent: "request",
    ttl: 3,
    hop_count: 0,
    idempotency_key: "idem-1",
    content: { text: "Return a result." },
    trace_id: "context-1",
    correlation_id: "task-1",
    task_id: "task-1",
    metadata: { session_id: "session-1" },
    ...overrides
  };
}

const delivery = {
  id: "delivery-1",
  message_id: "message-1",
  adapter_id: "agent-session-transport",
  target_agent_id: "agent.ingress.codex",
  status: "dispatching",
  attempts: 1,
  max_attempts: 1,
  created_at: "2026-08-30T12:00:00.000Z",
  updated_at: "2026-08-30T12:00:00.000Z"
};

test("session transport returns the correlated provider result", async () => {
  const calls = [];
  const registry = {
    has: () => true,
    async send(agentId, input) {
      calls.push({ agentId, input });
      return { ok: true, reply: "MESH_SESSION_OK" };
    }
  };
  const result = await new AgentSessionTransportAdapter(registry).dispatch(delivery, envelope());
  assert.equal(result.status, "delivered");
  assert.equal(result.details.reply, "MESH_SESSION_OK");
  assert.equal(result.details.correlation_id, "task-1");
  assert.equal(calls[0].input.sessionId, "session-1");
  assert.equal(calls[0].input.workspaceId, "workspace.allowed");
});

test("session transport distinguishes missing session and provider", async () => {
  const missingSession = await new AgentSessionTransportAdapter({ has: () => true }).dispatch(
    delivery,
    envelope({ metadata: {} })
  );
  assert.equal(missingSession.status, "failed");
  assert.equal(missingSession.details.reason, "session_id_missing");

  const missingProvider = await new AgentSessionTransportAdapter({ has: () => false }).dispatch(
    delivery,
    envelope()
  );
  assert.equal(missingProvider.status, "failed");
  assert.equal(missingProvider.details.reason, "session_provider_missing");
});
