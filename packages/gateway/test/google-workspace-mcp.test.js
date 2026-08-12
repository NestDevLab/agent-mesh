import assert from "node:assert/strict";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const { GogGoogleWorkspaceRunner } = await import("../src/mcp/google-workspace.ts");
const { createMcpHubHandler } = await import("../src/mcp/hub-mcp.ts");

test("gog runner appends non-interactive JSON flags and the configured account", async () => {
  const calls = [];
  const runner = new GogGoogleWorkspaceRunner(
    {
      work: { account: "work@example.test", client: "work" },
      personal: { account: "personal@example.test" }
    },
    "/opt/test/gog",
    1234,
    async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: JSON.stringify([{ id: "safe-result" }]) };
    }
  );

  assert.deepEqual(await runner.run("work", ["drive", "search", "proposal", "--max", "3"]), [
    { id: "safe-result" }
  ]);
  assert.equal(calls[0].file, "/opt/test/gog");
  assert.deepEqual(calls[0].args, [
    "drive", "search", "proposal", "--max", "3",
    "--json", "--results-only", "--no-input",
    "--account", "work@example.test", "--client", "work"
  ]);
  assert.equal(calls[0].options.timeout, 1234);
});

test("gog runner redacts process errors", async () => {
  const runner = new GogGoogleWorkspaceRunner(
    {
      work: { account: "work@example.test" },
      personal: { account: "personal@example.test" }
    },
    "/opt/test/gog",
    1234,
    async () => {
      throw new Error("secret provider output");
    }
  );
  await assert.rejects(runner.run("personal", ["gmail", "search", "safe"]), {
    message: "Google Workspace read failed."
  });
});

test("Google Workspace profile advertises only the read-only Google surface", async () => {
  const meshPrincipal = {
    id: "principal-test",
    kind: "user",
    requesterId: "agent.web",
    allowedTools: [],
    allowedAgentIds: [],
    allowedWorkspaceIds: [],
    allowedDomainIds: []
  };
  const handler = createMcpHubHandler({
    profile: "google-workspace",
    gateway: {
      async submitEnvelope() { throw new Error("not used"); },
      async getEnvelope() { return undefined; },
      async getDelivery() { return []; }
    },
    agents: [],
    rateLimiter: { consume() { return true; } },
    googleRunner: { async run() { return []; } },
    memoryState: "setup_required",
    resolvePrincipal: () => ({ mesh: meshPrincipal, allowedGoogleAccounts: ["work"] })
  });
  const requestOptions = {
    authInfo: { token: "x", clientId: "test", scopes: [] }
  };
  const request = new Request("https://mcp.example.test/google-workspace", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/list"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {}
        }
      }
    })
  });
  const response = await handler.fetch(request, requestOptions);
  const responseBody = await response.text();
  assert.equal(response.status, 200, responseBody);
  const payload = JSON.parse(responseBody);
  assert.deepEqual(payload.result.tools.map((tool) => tool.name).sort(), [
    "google_calendar_events",
    "google_drive_search",
    "google_gmail_search"
  ]);
  await handler.close();
});
