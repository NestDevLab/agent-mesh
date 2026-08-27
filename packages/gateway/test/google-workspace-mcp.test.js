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

test("gog runner classifies expired OAuth without exposing provider output", async () => {
  const runner = new GogGoogleWorkspaceRunner(
    {
      work: { account: "work@example.test" },
      personal: { account: "personal@example.test" }
    },
    "/opt/test/gog",
    1234,
    async () => {
      const error = new Error("command failed");
      error.stderr = "oauth invalid_grant secret-provider-detail";
      throw error;
    }
  );
  await assert.rejects(runner.run("personal", ["drive", "get", "file-id"]), {
    message: "Google Workspace authorization expired; reconnect the affected account and retry.",
    code: "oauth_reconnect_required",
    reconnectRequired: true
  });
});

test("gog runner reads a Google Doc returned as a results-only string", async () => {
  const runner = new GogGoogleWorkspaceRunner(
    {
      work: { account: "work@example.test" },
      personal: { account: "personal@example.test" }
    },
    "/opt/test/gog",
    1234,
    async (_file, args) => {
      if (args[0] === "drive" && args[1] === "get") {
        return { stdout: JSON.stringify({
          id: "doc-id",
          name: "Source document",
          mimeType: "application/vnd.google-apps.document",
          modifiedTime: "2026-08-17T00:00:00Z",
          webViewLink: "https://docs.example.test/doc-id"
        }) };
      }
      return { stdout: JSON.stringify("0123456789") };
    }
  );
  const value = await runner.readFile("work", "doc-id", 2, 4);
  assert.equal(value.content, "2345");
  assert.equal(value.has_more, true);
  assert.equal(value.next_start_char, 6);
  assert.equal(value.source_id, "doc-id");
  assert.equal(value.data_status, "source_record");
});

test("Google Workspace profile advertises only the read-only Google surface", async () => {
  const googleCalls = [];
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
    googleRunner: {
      async run(account, args, options) {
        googleCalls.push({ account, args, options });
        return { files: [{ id: "file-1", name: "Current source" }], nextPageToken: "p2" };
      },
      async readFile() { return { source_id: "safe-file", content: "safe-content" }; }
    },
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
    "google_drive_list",
    "google_drive_read",
    "google_drive_search",
    "google_gmail_search",
    "google_sheets_metadata",
    "google_sheets_read_range"
  ]);
  for (const tool of payload.result.tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
  }

  const callResponse = await handler.fetch(new Request("https://mcp.example.test/google-workspace", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "google_drive_search"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "google_drive_search",
        arguments: { account: "work", query: "current source", max_results: 5, page_token: "p1" },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {}
        }
      }
    })
  }), requestOptions);
  const callPayload = JSON.parse(await callResponse.text());
  assert.equal(callResponse.status, 200, JSON.stringify(callPayload));
  assert.equal(callPayload.result.structuredContent.results.files[0].id, "file-1");
  assert.equal(callPayload.result.structuredContent.results.next_page_token, "p2");
  assert.deepEqual(googleCalls[0], {
    account: "work",
    args: ["drive", "search", "current source", "--max", "5", "--page", "p1"],
    options: { resultsOnly: false }
  });
  await handler.close();
});
