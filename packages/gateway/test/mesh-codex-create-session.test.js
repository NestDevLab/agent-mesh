import assert from "node:assert/strict";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const { AgentSessionRegistry, ShellAgentSessionProvider } = await import("../src/adapters/agent-session-provider.ts");
const { MeshMcpFacade, createMeshMcpHandler } = await import("../src/mcp/mesh-mcp.ts");

const agentId = "agent.ingress.codex";
const workspaceId = "workspace.example";
const nativeId = "12345678-1234-4234-8234-123456789abc";

function harness({ profiles = ["read-only", "full-access"], resolved = true, writer = true, hostSocket = "mesh", persisted = true, sendCode = 0 } = {}) {
  const calls = [];
  const state = { persisted, writer, panePid: 4241, resolved, hostReady: true };
  const run = async (command, args, options) => {
    calls.push({ command, args: [...args], env: options.env });
    if (command === "/bridge/agent-send.sh") return { code: sendCode, stdout: sendCode ? "" : "FIRST_REPLY", stderr: sendCode ? "send failed" : "" };
    const sub = args[2];
    const ok = (stdout) => ({ code: 0, stdout, stderr: "" });
    if (sub === "socket-status") return state.hostReady ? ok("ready\n") : { code: 4, stdout: "", stderr: "not trusted" };
    if (sub === "new") return ok(`${args[4]}\n`);
    if (sub === "target-session") return state.resolved ? ok(`${nativeId}\n`) : { code: 4, stdout: "", stderr: "ambiguous" };
    if (sub === "writer-status") return ok(JSON.stringify({
      agent: "codex", sessionId: nativeId, writers: state.writer ? [{ pid: 4242, kind: "codex" }] : []
    }));
    if (sub === "target-status") return ok(JSON.stringify({ target: args[3], pane_pid: state.panePid, writer_pid: 4242 }));
    if ((sub === "inspect" || sub === "transcript") && !state.persisted) return { code: 3, stdout: "", stderr: "not found" };
    if (sub === "transcript") return ok(JSON.stringify({ agent_type: "codex", session_id: nativeId, events: [], next_cursor: null }));
    if (sub === "inspect") return ok(JSON.stringify({ agent_type: "codex", sessions: [{
      session_id: nativeId, agent_type: "codex", cwd: "/srv/workspaces/example/project", updated_at: "2026-10-13T00:00:00Z"
    }] }));
    if (sub === "kill") return ok("killed\n");
    throw new Error(`Unexpected bridge command: ${sub}`);
  };
  const provider = new ShellAgentSessionProvider({
    agentId, agentType: "codex", agentSessionPath: "/bridge/agent-session.sh",
    agentSendPath: "/bridge/agent-send.sh", workspaceRoots: { [workspaceId]: ["/srv/workspaces/example"], "workspace.other": ["/srv/workspaces/example"] },
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
  return { calls, facade, registry, options, provider, state };
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
  const payload = await response.json();
  return payload.result ?? { isError: true, error: payload.error };
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
  assert.deepEqual(h.calls.map((call) => call.args[2]), ["new", "target-session", "writer-status", "target-status", "target-session", "writer-status", "target-status", "inspect"]);
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
    workspaceRoots: { [workspaceId]: ["/srv/workspaces/example"], "workspace.other": ["/srv/workspaces/example"] },
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

const sendInput = { workspaceId, sessionId: nativeId, message: "Reply FIRST_REPLY", messageId: "first",
  contextId: "test", idempotencyKey: "first", correlationId: "first" };

for (const accessProfile of ["read-only", "full-access"]) test(`blank ${accessProfile} create/get/transcript and first send keep owned socket`, async () => {
  const h = harness({ persisted: false });
  const created = await h.provider.create({ workspaceId, accessProfile });
  assert.equal(created.session_id, nativeId);
  assert.equal((await h.provider.get({ workspaceId, sessionId: nativeId })).session_id, nativeId);
  assert.deepEqual((await h.provider.transcript({ workspaceId, sessionId: nativeId, limit: 10 })).events, []);
  assert.equal(await h.provider.get({ workspaceId: "workspace.other", sessionId: nativeId }), undefined);
  const before = h.calls.length;
  assert.equal((await h.provider.send({ ...sendInput, workspaceId: "workspace.other" })).ok, false);
  assert.equal(h.calls.length, before);
  assert.deepEqual(await h.provider.send(sendInput), { ok: true, reply: "FIRST_REPLY" });
  const sent = h.calls.find(call => call.command === "/bridge/agent-send.sh");
  const launch = h.calls.find(call => call.args[2] === "new");
  assert.ok(sent.args.includes(launch.args[4]));
  assert.equal(sent.env.MESH_TMUX_SOCKET, accessProfile === "full-access" ? "mesh" : "mesh-mcp-sessions");
  assert.ok(h.calls.filter(call => call.args[2] === "target-session").every(call => call.args.includes("--owned-cwd")));
  assert.equal(h.calls.some(call => call.args[2] === "resume"), false);
  // Persisted metadata takes over without losing the original socket capability.
  h.state.persisted = true;
  assert.equal((await h.provider.get({ workspaceId, sessionId: nativeId })).session_id, nativeId);
  assert.deepEqual(await h.provider.send(sendInput), { ok: true, reply: "FIRST_REPLY" });
});

test("unpersisted guessed ID and restart have no capability and fail clearly", async () => {
  const h = harness({ persisted: false });
  await assert.rejects(h.provider.get({ workspaceId, sessionId: nativeId }), /unpersisted ownership.*gateway restart/);
  await h.provider.create({ workspaceId, accessProfile: "read-only" });
  const restarted = harness({ persisted: false });
  await assert.rejects(restarted.provider.send(sendInput), /gateway restart/);
  assert.equal(restarted.calls.some(call => call.command === "/bridge/agent-send.sh"), false);
});

for (const change of [{ writer: false }, { panePid: 9999 }, { resolved: false }]) test(`owned proof loss kills target: ${JSON.stringify(change)}`, async () => {
  const h = harness({ persisted: false });
  await h.provider.create({ workspaceId, accessProfile: "full-access" });
  Object.assign(h.state, change);
  await assert.rejects(h.provider.send(sendInput), /Owned Codex/);
  assert.equal(h.calls.at(-1).args[2], "kill");
  assert.equal(h.calls.at(-1).env.MESH_TMUX_SOCKET, "mesh");
  assert.equal(h.calls.some(call => call.command === "/bridge/agent-send.sh"), false);
});

test("first send failure kills owned target on its original socket", async () => {
  const h = harness({ persisted: false, sendCode: 1 });
  await h.provider.create({ workspaceId, accessProfile: "full-access" });
  assert.equal((await h.provider.send(sendInput)).ok, false);
  assert.equal(h.calls.at(-1).args[2], "kill");
  assert.equal(h.calls.at(-1).env.MESH_TMUX_SOCKET, "mesh");
});

test("full-access socket rejection and per-principal gating prevent launch", async () => {
  const h = harness();
  h.state.hostReady = false;
  await assert.rejects(h.provider.create({ workspaceId, accessProfile: "full-access" }), /Trusted full-access/);
  assert.equal(h.calls.some(call => call.args[2] === "new"), false);
  const handler = createMeshMcpHandler({ ...h.options, resolvePrincipal: () => ({ ...h.options.principal, allowedTools: ["mesh_list_agents"] }) });
  const result = await callTool(handler, "mesh_agent_session_create", { target_agent_id: agentId, workspace_id: workspaceId });
  assert.equal(result.isError, true);
  assert.equal(h.calls.some(call => call.args[2] === "new"), false);
});
