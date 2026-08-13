import assert from "node:assert/strict";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const { StdioMemoryRecallRunner } = await import("../src/mcp/memory-recall.ts");
const { createMcpHubHandler } = await import("../src/mcp/hub-mcp.ts");

test("stdio memory runner sends one bounded MCP request without exposing process errors", async () => {
  const calls = [];
  const runner = new StdioMemoryRecallRunner(
    { command: "/usr/bin/node", script: "/opt/amf/recall.mjs", handoffDir: "/run/amf/chatgpt-web" },
    1234,
    async (command, args, input, options) => {
      calls.push({ command, args, message: JSON.parse(input), options });
      return JSON.stringify({ jsonrpc: "2.0", id: 1, result: {
        content: [{ type: "text", text: JSON.stringify({ items: [] }) }]
      } });
    }
  );
  assert.deepEqual(await runner.call("memory_search", { query: "safe", limit: 3 }), { items: [] });
  assert.equal(calls[0].options.env.AMF_INTERACTIVE_RECALL_HANDOFF_DIR, "/run/amf/chatgpt-web");
  assert.equal(calls[0].message.params.name, "memory_search");
});

test("memory profile advertises only status, search, and read", async () => {
  const meshPrincipal = { id: "p", kind: "user", requesterId: "agent.web", allowedTools: [],
    allowedAgentIds: [], allowedWorkspaceIds: [], allowedDomainIds: [] };
  const handler = createMcpHubHandler({
    profile: "memory",
    gateway: { async submitEnvelope() {}, async getEnvelope() {}, async getDelivery() { return []; } },
    agents: [], rateLimiter: { consume() { return true; } }, googleRunner: { async run() { return []; } },
    memoryState: "setup_required",
    memoryRunner: { async status() { return "ready"; }, async call() { return { items: [] }; } },
    resolvePrincipal: () => ({ mesh: meshPrincipal, allowedGoogleAccounts: [] })
  });
  const request = new Request("https://mcp.example.test/memory", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {}
    } } })
  });
  const response = await handler.fetch(request, { authInfo: { token: "x", clientId: "test", scopes: [] } });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(payload.result.tools.map((tool) => tool.name).sort(), [
    "memory_backend_status", "memory_read", "memory_search"
  ]);
  await handler.close();
});
