import assert from "node:assert/strict";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const {
  FixedWindowMeshMcpRateLimiter,
  MeshMcpFacade,
  createMeshMcpHandler,
  createMeshMcpServer
} = await import(
  "../src/mcp/mesh-mcp.ts"
);
const { adaptMcpRequestBody, wrapSingletonJsonRpcResponse } = await import(
  "../src/mcp/serve.ts"
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
    },
    async getEnvelope(messageId) {
      return this.submitted.find((envelope) => envelope.message_id === messageId);
    }
  };
}

function options(gateway = createGateway()) {
  return {
    gateway,
    principal: {
      id: "principal-test",
      kind: "user",
      requesterId: "agent.web_chat",
      allowedTools: ["mesh_list_agents", "mesh_send", "mesh_delivery_status"],
      allowedAgentIds: ["agent.codex", "agent.claude"],
      allowedWorkspaceIds: ["workspace.demo"],
      allowedDomainIds: ["domain.demo"]
    },
    agents: [
      { id: "agent.codex", name: "Codex", provider: "codex", capabilities: ["development"] },
      { id: "agent.claude", name: "Claude", provider: "claude", capabilities: ["analysis"] }
    ],
    rateLimiter: new FixedWindowMeshMcpRateLimiter(),
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
    idempotency_key: "principal-test:web-request-1",
    content: { text: "Review the proposed bridge." },
    sensitivity: "private",
    redaction_state: "required",
    metadata: {
      ingress: "mcp",
      a2a_operation: "request",
      principal_id: "principal-test",
      principal_kind: "user"
    },
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
  const sent = await facade.dispatch({
    targetAgentId: "agent.codex",
    workspaceId: "workspace.demo",
    domainId: "domain.demo",
    conversationId: "conversation-1",
    message: "Create an owned delivery record."
  });
  const deliveries = await facade.deliveryStatus(sent.messageId);
  assert.deepEqual(deliveries, [
    { id: "delivery-status-1", message_id: sent.messageId, status: "delivered" }
  ]);
  assert.equal(gateway.submitted.length, 1);
});

test("MCP facade rejects scopes outside the authenticated principal", async () => {
  const facade = new MeshMcpFacade(options());
  await assert.rejects(
    facade.dispatch({
      targetAgentId: "agent.codex",
      workspaceId: "workspace.other",
      domainId: "domain.demo",
      conversationId: "conversation-1",
      message: "Must not cross workspace boundaries."
    }),
    /workspace is not allowed/
  );
});

test("MCP facade refuses delivery records owned by another principal", async () => {
  const gateway = createGateway();
  gateway.submitted.push({
    message_id: "mcp_foreign",
    from: "agent.other",
    metadata: { ingress: "mcp", principal_id: "principal-other" }
  });
  const facade = new MeshMcpFacade(options(gateway));
  await assert.rejects(facade.deliveryStatus("mcp_foreign"), /not owned/);
});

test("MCP send rate limit fails closed", async () => {
  const setup = options();
  setup.rateLimiter = new FixedWindowMeshMcpRateLimiter({
    mesh_list_agents: 1,
    mesh_send: 1,
    mesh_delivery_status: 1
  });
  const facade = new MeshMcpFacade(setup);
  const input = {
    targetAgentId: "agent.codex",
    workspaceId: "workspace.demo",
    domainId: "domain.demo",
    conversationId: "conversation-1",
    message: "One request only."
  };
  await facade.dispatch(input);
  await assert.rejects(facade.dispatch(input), /Rate limit exceeded/);
});

test("MCP server and strict Streamable HTTP handler can be composed", async () => {
  const setup = options();
  assert.equal(createMeshMcpServer(setup).isConnected(), false);
  const handler = createMeshMcpHandler({
    gateway: setup.gateway,
    agents: setup.agents,
    rateLimiter: setup.rateLimiter,
    now: setup.now,
    resolvePrincipal: () => setup.principal
  });
  assert.equal(typeof handler.fetch, "function");
  const unauthenticated = await handler.fetch(new Request("https://mcp.example.test/mcp"));
  assert.equal(unauthenticated.status, 401);
});

test("ChatGPT singleton tools/call batches are adapted without enabling general batching", () => {
  const request = {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "mesh_list_agents", arguments: {} }
  };
  const singleton = adaptMcpRequestBody(
    Buffer.from(JSON.stringify([request])),
    "2026-07-28",
    "tools/call"
  );
  assert.equal(singleton.wrapJsonRpcResponse, true);
  assert.deepEqual(JSON.parse(Buffer.from(singleton.body).toString("utf8")), request);

  const multiple = adaptMcpRequestBody(
    Buffer.from(JSON.stringify([request, { ...request, id: 8 }])),
    "2026-07-28",
    "tools/call"
  );
  assert.equal(multiple.wrapJsonRpcResponse, false);
  assert.deepEqual(
    JSON.parse(Buffer.from(multiple.body).toString("utf8")),
    [request, { ...request, id: 8 }]
  );
});

test("ChatGPT singleton compatibility wraps only JSON-RPC responses", async () => {
  const jsonRpc = await wrapSingletonJsonRpcResponse(Response.json({
    jsonrpc: "2.0",
    id: 7,
    result: { content: [] }
  }));
  assert.deepEqual(await jsonRpc.json(), [{
    jsonrpc: "2.0",
    id: 7,
    result: { content: [] }
  }]);

  const authError = await wrapSingletonJsonRpcResponse(Response.json(
    { error: "unauthorized" },
    { status: 401 }
  ));
  assert.equal(authError.status, 401);
  assert.deepEqual(await authError.json(), { error: "unauthorized" });
});
