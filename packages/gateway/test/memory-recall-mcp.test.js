import assert from "node:assert/strict";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const { MemoryRecallError, StdioMemoryRecallRunner } = await import("../src/mcp/memory-recall.ts");
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

test("stdio memory runner preserves sanitized governed-write diagnoses", async () => {
  for (const [error, expected] of [
    [{ code: -32602, message: "Invalid governed memory record", data: { code: "canonical_record_invalid", fields: ["confidence", "secret"] } },
      { code: "canonical_record_invalid", details: { fields: ["confidence"], action: "Use the published amf-memory/v1 record template and supply every required field." } }],
    [{ code: -32602, message: "Governed memory proposal is too large", data: { code: "proposal_too_large", maxChars: 32768, observedChars: 45000 } },
      { code: "proposal_too_large", details: { maxChars: 32768, observedChars: 45000, strategy: "summary_plus_pointer", action: "Store the full document durably, then submit a bounded summary or instruction claim with a durable reference." } }]
  ]) {
    const runner = new StdioMemoryRecallRunner(
      { command: "/usr/bin/node", script: "/opt/amf/recall.mjs", handoffDir: "/run/amf/chatgpt-web", governedWrite: true },
      1234,
      async () => JSON.stringify({ jsonrpc: "2.0", id: 1, error })
    );
    await assert.rejects(runner.call("memory_upsert", {}), (failure) => {
      assert.ok(failure instanceof MemoryRecallError);
      assert.equal(failure.code, expected.code);
      assert.deepEqual(failure.details, expected.details);
      return true;
    });
  }
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

test("governed memory write advertises proposal-only upsert, maps revision fields, and returns actionable errors", async () => {
  const calls = []; const meshPrincipal = { id: "p", kind: "user", requesterId: "agent.web", allowedTools: [],
    allowedAgentIds: [], allowedWorkspaceIds: [], allowedDomainIds: [] };
  let failure = null;
  const runner = { governedWrite: true, async status() { return "ready"; }, async call(name, input) {
    if (failure !== null) throw failure;
    calls.push({ name, input }); return { status: "queued", proposalId: "proposal:1" };
  } };
  const handler = createMcpHubHandler({ profile: "memory",
    gateway: { async submitEnvelope() {}, async getEnvelope() {}, async getDelivery() { return []; } },
    agents: [], rateLimiter: { consume() { return true; } }, googleRunner: { async run() { return []; } },
    memoryState: "ready", memoryRunner: runner,
    resolvePrincipal: () => ({ mesh: meshPrincipal, allowedGoogleAccounts: [] }) });
  const authInfo = { token: "x", clientId: "test", scopes: [] };
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" };
  const list = await handler.fetch(new Request("https://mcp.example.test/memory", { method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {}
    } } }) }), { authInfo });
  const listed = await list.json();
  assert.deepEqual(listed.result.tools.map(tool => tool.name).sort(), ["memory_backend_status", "memory_proposal_status",
    "memory_read", "memory_search", "memory_upsert"]);
  const upsertTool = listed.result.tools.find(tool => tool.name === "memory_upsert");
  assert.match(upsertTool.description, /schema, id, revision, claimType, scope, visibility, subjects, claim, confidence, lifecycle, provenance, createdAt, and updatedAt/);
  assert.match(upsertTool.description, /summary or instruction claim/);
  assert.match(upsertTool.description, /mem_example_handoff_0001/);
  const call = await handler.fetch(new Request("https://mcp.example.test/memory", { method: "POST",
    headers: { ...headers, "mcp-method": "tools/call", "mcp-name": "memory_upsert" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2,
      method: "tools/call", params: { name: "memory_upsert", arguments: { record: { id: "memory:new" },
        rationale: "verified", expected_revision: 1, idempotency_key: "test-upsert" }, _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {}
        } } }) }), { authInfo });
  const callPayload = await call.json();
  assert.equal(call.status, 200, JSON.stringify(callPayload));
  assert.deepEqual(calls[0], { name: "memory_upsert", input: { record: { id: "memory:new" }, rationale: "verified",
    expectedRevision: 1, idempotencyKey: "test-upsert" } });
  failure = new MemoryRecallError("proposal_too_large", "Governed memory proposal is too large.", {
    maxChars: 32768, observedChars: 45000, strategy: "summary_plus_pointer",
    action: "Store the full document durably, then submit a bounded summary or instruction claim with a durable reference."
  });
  const rejected = await handler.fetch(new Request("https://mcp.example.test/memory", { method: "POST",
    headers: { ...headers, "mcp-method": "tools/call", "mcp-name": "memory_upsert" }, body: JSON.stringify({ jsonrpc: "2.0", id: 3,
      method: "tools/call", params: { name: "memory_upsert", arguments: { record: { id: "memory:new" },
        rationale: "verified", expected_revision: 1, idempotency_key: "test-upsert-error" }, _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {}
        } } }) }), { authInfo });
  const rejectedPayload = await rejected.json();
  assert.equal(rejected.status, 200, JSON.stringify(rejectedPayload));
  assert.equal(rejectedPayload.result.isError, true);
  assert.deepEqual(rejectedPayload.result.structuredContent, { error: {
    code: "proposal_too_large", maxChars: 32768, observedChars: 45000, strategy: "summary_plus_pointer",
    action: "Store the full document durably, then submit a bounded summary or instruction claim with a durable reference."
  } });
  await handler.close();
});
