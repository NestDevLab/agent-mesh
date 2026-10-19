import assert from "node:assert/strict";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const { AgentSessionRegistry, ShellAgentSessionProvider } = await import("../src/adapters/agent-session-provider.ts");
const { MeshMcpFacade, createMeshMcpHandler } = await import("../src/mcp/mesh-mcp.ts");

const agentId = "agent.ingress.codex";
const workspaceId = "workspace.example";
const nativeId = "12345678-1234-4234-8234-123456789abc";

function harness({ profiles = ["read-only", "full-access"], resolved = true, writer = true, hostSocket = "mesh" } = {}) {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args: [...args], env: options.env });
    const sub = args[2];
    const ok = (stdout) => ({ code: 0, stdout, stderr: "" });
    if (sub === "socket-status") return ok("ready\n");
    if (sub === "new") return ok(`${args[4]}\n`);
    if (sub === "target-session") return resolved ? ok(`${nativeId}\n`) : { code: 4, stdout: "", stderr: "ambiguous" };
    if (sub === "writer-status") return ok(JSON.stringify({
      agent: "codex", sessionId: nativeId, writers: writer ? [{ pid: 4242, kind: "codex" }] : []
    }));
    if (sub === "target-status") return ok(JSON.stringify({ target: args[3], pane_pid: 4241, writer_pid: 4242 }));
    if (sub === "inspect") return ok(JSON.stringify({ agent_type: "codex", sessions: [{
      session_id: nativeId, agent_type: "codex", cwd: "/srv/workspaces/example/project", updated_at: "2026-10-13T00:00:00Z"
    }] }));
    if (sub === "kill") return ok("killed\n");
    throw new Error(`Unexpected bridge command: ${sub}`);
  };
  const provider = new ShellAgentSessionProvider({
    agentId, agentType: "codex", agentSessionPath: "/bridge/agent-session.sh",
    agentSendPath: "/bridge/agent-send.sh", workspaceRoots: { [workspaceId]: ["/srv/workspaces/example"] },
    freshSessionCwds: { [workspaceId]: "/srv/workspaces/example/project" }, createSessionProfiles: profiles,
    fullAccessMeshSocket: hostSocket, meshSocket: "mesh-mcp-sessions", run
  });
  const registry = new AgentSessionRegistry([provider]);
  const options = {
    gateway: {}, agents: [{ id: agentId, name: "Codex ingress", provider: "codex", capabilities: ["submit_request"] }],
    principal: { id: "user", kind: "user", requesterId: "mcp", allowedTools: ["mesh_list_agents", "mesh_agent_session_create"],
      allowedAgentIds: [agentId], allowedWorkspaceIds: [workspaceId], allowedDomainIds: [] },
    rateLimiter: { consume: () => true }, sessionRegistry: registry
  };
  const facade = new MeshMcpFacade(options);
  return { calls, facade, registry, options };
}

async function callTool(handler, name, args) {
  const response = await handler.fetch(new Request("https://mcp.example.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name, arguments: args, _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "codex-create-test", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {}
      }
    } })
  }), { authInfo: { token: "t", clientId: "client", scopes: [] } });
  assert.equal(response.status, 200);
  return (await response.json()).result;
}

test("Codex creation advertises capability and launches read-only by default", async () => {
  const h = harness();
  assert.deepEqual(h.facade.listAgents()[0].capabilities, ["submit_request", "create_session"]);
  const created = await h.facade.createAgentSession({ targetAgentId: agentId, workspaceId, accessProfile: "read-only" });
  assert.equal(created.session_id, nativeId);
  const launch = h.calls.find((call) => call.args[2] === "new");
  assert.deepEqual(launch.args.slice(0, 4), ["--agent", "codex", "new", "/srv/workspaces/example/project"]);
  assert.deepEqual(launch.args.slice(5), ["--", "--sandbox", "read-only"]);
  assert.equal(launch.env.MESH_STRICT_READY, "1");
  assert.equal(launch.env.MESH_TMUX_SOCKET, "mesh-mcp-sessions");
  assert.match(launch.args[4], /^mesh-codex-[0-9a-f-]{36}$/);
  assert.deepEqual(h.calls.map((call) => call.args[2]), ["new", "target-session", "writer-status", "target-status", "inspect"]);
});

test("full-access is explicit and unavailable unless enabled by the host", async () => {
  const restricted = harness({ profiles: ["read-only"] });
  await assert.rejects(restricted.facade.createAgentSession({ targetAgentId: agentId, workspaceId, accessProfile: "full-access" }), /not allowed/);
  assert.equal(restricted.calls.length, 0);
  const h = harness();
  await h.facade.createAgentSession({ targetAgentId: agentId, workspaceId, accessProfile: "full-access" });
  const launch = h.calls.find((call) => call.args[2] === "new");
  assert.deepEqual(launch.args.slice(5), ["--", "--sandbox", "danger-full-access", "--ask-for-approval", "never"]);
  assert.equal(launch.env.MESH_TMUX_SOCKET, "mesh");
  assert.equal(h.calls[0].args[2], "socket-status");
  assert.equal(h.calls[0].env.MESH_TMUX_SOCKET, "mesh");
  await assert.rejects(h.facade.createAgentSession({ targetAgentId: agentId, workspaceId: "workspace.other", accessProfile: "read-only" }), /not allowed|not configured/);
  assert.throws(() => harness({ hostSocket: "mesh-mcp-sessions" }), /distinct trusted host tmux socket/);
  assert.throws(() => new ShellAgentSessionProvider({
    agentId, agentType: "codex", agentSessionPath: "/bridge/agent-session.sh", agentSendPath: "/bridge/agent-send.sh",
    workspaceRoots: { [workspaceId]: ["/srv/workspaces/example"] },
    freshSessionCwds: { [workspaceId]: '/srv/workspaces/example/"unsafe' }
  }), /outside the workspace roots/);
});

test("unknown profiles, unresolved IDs and wrong writers fail closed", async () => {
  assert.throws(() => harness({ profiles: ["unknown"] }), /Unknown session access profile/);
  const unknown = harness();
  await assert.rejects(unknown.facade.createAgentSession({ targetAgentId: agentId, workspaceId, accessProfile: "unknown" }), /not allowed/);
  assert.equal(unknown.calls.length, 0);
  for (const settings of [{ resolved: false }, { writer: false }]) {
    const h = harness(settings);
    await assert.rejects(h.facade.createAgentSession({ targetAgentId: agentId, workspaceId, accessProfile: "read-only" }));
    assert.equal(h.calls.at(-1).args[2], "kill");
  }
});

test("MCP tool rejects unknown access profiles before any launch", async () => {
  const h = harness();
  const handler = createMeshMcpHandler({ ...h.options, resolvePrincipal: () => h.options.principal });
  const rejected = await callTool(handler, "mesh_agent_session_create", {
    target_agent_id: agentId, workspace_id: workspaceId, access_profile: "root"
  });
  assert.equal(rejected.isError, true);
  assert.equal(h.calls.length, 0);
  const created = await callTool(handler, "mesh_agent_session_create", {
    target_agent_id: agentId, workspace_id: workspaceId, access_profile: "full-access"
  });
  assert.equal(created.structuredContent.session.session_id, nativeId);
  assert.equal(created.structuredContent.access_profile, "full-access");
});
