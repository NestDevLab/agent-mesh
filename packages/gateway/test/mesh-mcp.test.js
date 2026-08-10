import assert from "node:assert/strict";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const { MeshMcpFacade, createMeshMcpHandler, createMeshMcpServer } = await import(
  "../src/mcp/mesh-mcp.ts"
);

function createGateway() {
  return {
    submitted: [],
    async submitEnvelope(input) {
      this.submitted.push(input);
      return {
        envelope: input,
        duplicate: false,
        deliveries: [
          {
            id: "delivery-1",
            message_id: input.message_id,
            adapter_id: "tmux-transport",
            target_agent_id: input.to,
            status: "stubbed",
            attempts: 1,
            max_attempts: 1,
            created_at: input.created_at,
            updated_at: input.created_at
          }
        ],
        auditEventIds: []
      };
    },
    async getDelivery(messageId) {
      return [{ id: "delivery-status-1", message_id: messageId, status: "delivered" }];
    }
  };
}

function options(gateway = createGateway()) {
  return {
    gateway,
    requesterId: "agent.web_chat",
    agents: [
      { id: "agent.codex", name: "Codex", provider: "codex", capabilities: ["development"] },
      { id: "agent.claude", name: "Claude", provider: "claude", capabilities: ["analysis"] }
    ],
    now: () => new Date("2026-08-10T12:00:00.000Z")
  };
}

test("MCP facade exposes only configured A2A endpoints", () => {
  const facade = new MeshMcpFacade(options());
  assert.deepEqual(
    facade.listAgents().map((agent) => agent.id),
    ["agent.codex", "agent.claude"]
  );
});

test("MCP facade converts a web request to a governed mesh request envelope", async () => {
  const gateway = createGateway();
  const facade = new MeshMcpFacade(options(gateway));

  const response = await facade.dispatch({
    targetAgentId: "agent.codex",
    workspaceId: "workspace.demo",
    domainId: "domain.demo",
    conversationId: "conversation-1",
    message: "Review the proposed bridge.",
    idempotencyKey: "web-request-1",
    labels: ["bridge"]
  });

  assert.match(response.messageId, /^mcp_/);
  assert.equal(response.deliveries[0].target_agent_id, "agent.codex");
  assert.equal(gateway.submitted.length, 1);
  assert.deepEqual(gateway.submitted[0], {
    schema: "openclaw.agent.message.v1",
    message_id: response.messageId,
    created_at: "2026-08-10T12:00:00.000Z",
    workspace_id: "workspace.demo",
    domain_id: "domain.demo",
    conversation_id: "conversation-1",
    from: "agent.web_chat",
    to: "agent.codex",
    intent: "request",
    ttl: 3,
    hop_count: 0,
    idempotency_key: "web-request-1",
    content: { text: "Review the proposed bridge." },
    sensitivity: "private",
    redaction_state: "required",
    metadata: { ingress: "mcp", a2a_operation: "request" },
    labels: ["bridge"]
  });
});

test("MCP facade rejects a target that the deployment did not expose", async () => {
  const facade = new MeshMcpFacade(options());
  await assert.rejects(
    facade.dispatch({
      targetAgentId: "agent.unapproved",
      workspaceId: "workspace.demo",
      domainId: "domain.demo",
      conversationId: "conversation-1",
      message: "Should not leave the allow-list."
    }),
    /not exposed/
  );
});

test("MCP facade reads delivery status without emitting another envelope", async () => {
  const gateway = createGateway();
  const facade = new MeshMcpFacade(options(gateway));
  const deliveries = await facade.deliveryStatus("mcp_known");
  assert.deepEqual(deliveries, [
    { id: "delivery-status-1", message_id: "mcp_known", status: "delivered" }
  ]);
  assert.equal(gateway.submitted.length, 0);
});

test("MCP server and strict Streamable HTTP handler can be composed", () => {
  const setup = options();
  assert.equal(createMeshMcpServer(setup).isConnected(), false);
  assert.equal(typeof createMeshMcpHandler(setup).fetch, "function");
});
