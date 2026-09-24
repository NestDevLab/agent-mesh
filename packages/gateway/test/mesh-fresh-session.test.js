import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const { GatewayService } = await import("../src/core/gateway-service.ts");
const { AgentRegistry } = await import("../src/core/agent-registry.ts");
const { ContextRegistry } = await import("../src/core/context-registry.ts");
const { SimulatedAgentAdapter } = await import("../src/adapters/simulated-agent-adapter.ts");
const { DiscordTranscriptStubAdapter } = await import("../src/adapters/discord-transcript-stub-adapter.ts");
const { AgentSessionRegistry, ShellAgentSessionProvider } = await import("../src/adapters/agent-session-provider.ts");
const { AgentSessionTransportAdapter } = await import("../src/adapters/agent-session-transport-adapter.ts");
const { MeshTaskStore } = await import("../src/mcp/mesh-task-store.ts");
const { MeshTaskCoordinator } = await import("../src/mcp/mesh-task-coordinator.ts");
const {
  FixedWindowMeshMcpRateLimiter,
  MeshMcpFacade,
  createMeshMcpHandler,
  executeMeshTask
} = await import("../src/mcp/mesh-mcp.ts");

const CLAUDE = "agent.ingress.claude";
const CODEX = "agent.ingress.codex";
const WORKSPACE = "workspace.example";
const OTHER_WORKSPACE = "workspace.other";
const DOMAIN = "domain.example";
const TRUSTED_CWD = "/srv/workspaces/example/fresh";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// fake agent-session.sh / agent-send.sh, never launches a real provider
function fakeBridge(behavior = {}) {
  const calls = [];
  const live = new Set();
  const run = async (command, args, options) => {
    calls.push({ command, args: [...args], env: options.env });
    const sub = args[2];
    if (command === "/bridge/agent-session.sh" && sub === "new") {
      if (behavior.createGate !== undefined) await behavior.createGate;
      if (behavior.createFails) return { code: 124, stdout: "", stderr: "ERROR: session 'x' is not ready" };
      const sessionId = args[args.indexOf("--session-id") + 1];
      if (!behavior.noWriter) live.add(sessionId);
      return { code: 0, stdout: `${args[4]}\n`, stderr: "" };
    }
    if (command === "/bridge/agent-session.sh" && sub === "writer-status") {
      const sessionId = args[3];
      const writers = live.has(sessionId) ? [{ pid: 4242, kind: "claude-cli" }] : [];
      return {
        code: 0,
        stdout: JSON.stringify({ agent: "claude", sessionId, writers, discovery: { complete: true } }),
        stderr: ""
      };
    }
    if (command === "/bridge/agent-session.sh" && sub === "target-status") {
      return { code: 0, stdout: JSON.stringify({ target: args[3], pane_pid: 4241, writer_pid: 4242 }), stderr: "" };
    }
    if (command === "/bridge/agent-session.sh" && sub === "inspect") {
      const sessionId = args[3];
      return {
        code: 0,
        stdout: JSON.stringify({ agent_type: args[1], sessions: [
          { session_id: sessionId, agent_type: args[1], cwd: "/srv/workspaces/example/project", updated_at: "2026-09-01T00:00:00Z" }
        ] }),
        stderr: ""
      };
    }
    if (command === "/bridge/agent-session.sh" && sub === "resume") {
      live.add(args[3]);
      return { code: 0, stdout: `mesh-${args[1]}-${args[3].slice(0, 8)}\n`, stderr: "" };
    }
    if (command === "/bridge/agent-send.sh") {
      const correlationId = args[args.indexOf("--correlation-id") + 1];
      if (behavior.send !== undefined) return behavior.send(correlationId, args);
      return { code: 0, stdout: `reply for ${correlationId}\n`, stderr: "" };
    }
    throw new Error(`Unexpected bridge command: ${command} ${args.join(" ")}`);
  };
  return { run, calls };
}

function sessionProviders(run) {
  return new AgentSessionRegistry([
    new ShellAgentSessionProvider({
      agentId: CLAUDE,
      agentType: "claude",
      agentSessionPath: "/bridge/agent-session.sh",
      agentSendPath: "/bridge/agent-send.sh",
      workspaceRoots: {
        [WORKSPACE]: ["/srv/workspaces/example"],
        [OTHER_WORKSPACE]: ["/srv/workspaces/other"]
      },
      freshSessionCwds: { [WORKSPACE]: TRUSTED_CWD },
      meshSocket: "mesh-fresh-test",
      run
    }),
    new ShellAgentSessionProvider({
      agentId: CODEX,
      agentType: "codex",
      agentSessionPath: "/bridge/agent-session.sh",
      agentSendPath: "/bridge/agent-send.sh",
      workspaceRoots: { [WORKSPACE]: ["/srv/workspaces/example"] },
      run
    })
  ]);
}

const PRINCIPAL = {
  id: "principal-web",
  kind: "user",
  requesterId: "agent.mcp.web",
  allowedTools: ["mesh_list_agents", "mesh_call", "mesh_submit", "mesh_task_get", "mesh_task_cancel"],
  allowedAgentIds: [CLAUDE, CODEX],
  allowedWorkspaceIds: [WORKSPACE, OTHER_WORKSPACE],
  allowedDomainIds: [DOMAIN]
};

const AGENTS = [
  { id: CLAUDE, name: "Claude ingress", provider: "claude", capabilities: ["submit_request"] },
  { id: CODEX, name: "Codex ingress", provider: "codex", capabilities: ["submit_request"] }
];

async function harness(behavior = {}, { resultWaitMs = 200 } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "agent-mesh-fresh-"));
  const bridge = fakeBridge(behavior);
  const sessionRegistry = sessionProviders(bridge.run);
  const contexts = [WORKSPACE, OTHER_WORKSPACE].map((id) => ({
    id, type: "workspace", name: id, parent_id: null, policy_profile: "private", status: "active"
  }));
  contexts.push({
    id: DOMAIN, type: "project", name: DOMAIN, parent_id: WORKSPACE, policy_profile: "private", status: "active"
  });
  const enabled = [WORKSPACE, OTHER_WORKSPACE, DOMAIN];
  const gateway = new GatewayService({
    stateDir,
    contextRegistry: new ContextRegistry(contexts),
    agentRegistry: new AgentRegistry([
      { id: PRINCIPAL.requesterId, name: "Web requester", role: "mcp_ingress", status: "online",
        phase_1_active: true, capabilities: ["submit_request"], enabled_contexts: enabled },
      ...AGENTS.map(({ id, name }) => ({
        id, name, role: "mcp_ingress", status: "online", phase_1_active: true,
        capabilities: ["submit_request"], enabled_contexts: enabled
      }))
    ]),
    adapters: [
      new SimulatedAgentAdapter(),
      new DiscordTranscriptStubAdapter(),
      new AgentSessionTransportAdapter(sessionRegistry)
    ]
  });
  const store = new MeshTaskStore({ stateDir });
  const taskCoordinator = new MeshTaskCoordinator({
    store,
    execute: (task) => executeMeshTask(gateway, task, () => new Date(), { resultWaitMs, resultPollMs: 5 })
  });
  const common = {
    gateway,
    agents: AGENTS,
    taskCoordinator,
    sessionRegistry,
    rateLimiter: new FixedWindowMeshMcpRateLimiter()
  };
  const facade = new MeshMcpFacade({ ...common, principal: PRINCIPAL });
  const handler = createMeshMcpHandler({ ...common, resolvePrincipal: () => PRINCIPAL });
  const cleanup = () => rm(stateDir, { recursive: true, force: true });
  return { stateDir, bridge, store, taskCoordinator, facade, handler, gateway, sessionRegistry, cleanup };
}

function fresh(overrides = {}) {
  return {
    targetAgentId: CLAUDE,
    workspaceId: WORKSPACE,
    domainId: DOMAIN,
    sessionMode: "fresh",
    message: "Reply with nonce XYZ",
    idempotencyKey: "fresh-1",
    ...overrides
  };
}

function sessionCommands(calls, sub) {
  return calls.filter((call) => call.command === "/bridge/agent-session.sh" && call.args[2] === sub);
}

async function waitForTerminal(facade, taskId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = await facade.getTask(taskId);
    if (["completed", "failed", "cancelled"].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Task did not finish: ${taskId}`);
}

async function callTool(handler, name, args) {
  const response = await handler.fetch(new Request("https://mcp.example.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": name
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "fresh-session-test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {}
        }
      }
    })
  }), { authInfo: { token: "t", clientId: "client", scopes: [] } });
  assert.equal(response.status, 200);
  return (await response.json()).result;
}

test("fresh mesh_call creates a Claude session through the bridge and returns its correlated result", async () => {
  const h = await harness();
  try {
    const { task, duplicate } = await h.facade.callTask(fresh(), 2_000);
    assert.equal(duplicate, false);
    assert.equal(task.status, "completed", JSON.stringify(task.error));
    assert.match(task.session_id, UUID);
    assert.equal(task.session_mode, "fresh");
    assert.deepEqual(task.session_provenance, {
      origin: "fresh",
      provider: "claude",
      agent_id: CLAUDE,
      session_id: task.session_id,
      model: "unknown",
      effort: "unknown"
    });
    assert.equal(task.result.text, `reply for ${task.task_id}`);

    const [created] = sessionCommands(h.bridge.calls, "new");
    assert.deepEqual(created.args, [
      "--agent", "claude", "new", TRUSTED_CWD, `mesh-claude-${task.session_id}`,
      "--", "--session-id", task.session_id
    ]);
    assert.equal(created.env.MESH_STRICT_READY, "1");
    assert.equal(created.env.MESH_TMUX_SOCKET, "mesh-fresh-test");
    assert.equal(sessionCommands(h.bridge.calls, "resume").length, 0);
    const send = h.bridge.calls.find((call) => call.command === "/bridge/agent-send.sh");
    assert.ok(send.args.includes(`mesh-claude-${task.session_id}`));
    assert.equal(send.args[send.args.indexOf("--correlation-id") + 1], task.task_id);

    const fetched = await h.facade.getTask(task.task_id);
    assert.equal(fetched.result.text, task.result.text);
    assert.equal(fetched.session_id, task.session_id);
  } finally { await h.cleanup(); }
});

test("replaying a fresh request with the same idempotency key reuses the task and session", async () => {
  const h = await harness();
  try {
    const first = await h.facade.callTask(fresh(), 2_000);
    const replay = await h.facade.callTask(fresh(), 2_000);
    const submitted = await h.facade.submitTask(fresh());
    assert.equal(replay.duplicate, true);
    assert.equal(submitted.duplicate, true);
    for (const output of [replay, submitted]) {
      assert.equal(output.task.task_id, first.task.task_id);
      assert.equal(output.task.session_id, first.task.session_id);
    }
    assert.equal(sessionCommands(h.bridge.calls, "new").length, 1);
    assert.equal(h.bridge.calls.filter((call) => call.command === "/bridge/agent-send.sh").length, 1);

    const [a, b] = await Promise.all([
      h.facade.submitTask(fresh({ idempotencyKey: "concurrent" })),
      h.facade.submitTask(fresh({ idempotencyKey: "concurrent" }))
    ]);
    assert.equal(a.task.session_id, b.task.session_id);
    await waitForTerminal(h.facade, a.task.task_id);
    assert.equal(sessionCommands(h.bridge.calls, "new").length, 2);

    await assert.rejects(
      h.facade.submitTask(fresh({ sessionMode: undefined })),
      /idempotency key conflicts/
    );
  } finally { await h.cleanup(); }
});

test("fresh mode is rejected for providers without fresh-session support", async () => {
  const h = await harness();
  try {
    await assert.rejects(
      h.facade.callTask(fresh({ targetAgentId: CODEX }), 2_000),
      (error) => error.code === "fresh_session_unsupported"
    );
    const withoutRegistry = new MeshMcpFacade({
      gateway: h.gateway,
      principal: PRINCIPAL,
      agents: AGENTS,
      taskCoordinator: h.taskCoordinator,
      rateLimiter: new FixedWindowMeshMcpRateLimiter()
    });
    await assert.rejects(
      withoutRegistry.submitTask(fresh()),
      (error) => error.code === "fresh_session_unsupported"
    );
    assert.equal(h.bridge.calls.length, 0);
    assert.deepEqual(await h.store.list(), []);
  } finally { await h.cleanup(); }
});

test("fresh mode fails closed for a workspace without a trusted fresh-session directory", async () => {
  const h = await harness();
  try {
    await assert.rejects(
      h.facade.callTask(fresh({ workspaceId: OTHER_WORKSPACE }), 2_000),
      (error) => error.code === "fresh_session_workspace_unauthorized"
    );
    await assert.rejects(
      h.facade.callTask(fresh({ workspaceId: "workspace.not-granted" }), 2_000),
      /workspace is not allowed/
    );
    assert.equal(h.bridge.calls.length, 0);
    assert.deepEqual(await h.store.list(), []);
  } finally { await h.cleanup(); }
});

test("fresh mode cannot be combined with an existing session_id", async () => {
  const h = await harness();
  try {
    await assert.rejects(
      h.facade.submitTask(fresh({ sessionId: "11111111-1111-4111-8111-111111111111" })),
      (error) => error.code === "session_mode_conflict"
    );
    assert.equal(h.bridge.calls.length, 0);
  } finally { await h.cleanup(); }
});

test("a failed session creation fails the task without falling back to another session", async () => {
  for (const behavior of [{ createFails: true }, { noWriter: true }]) {
    const h = await harness(behavior);
    try {
      const { task } = await h.facade.callTask(fresh(), 2_000);
      assert.equal(task.status, "failed");
      assert.equal(task.error.code, "fresh_session_create_failed");
      assert.equal(task.result, undefined);
      assert.equal(sessionCommands(h.bridge.calls, "new").length, 1);
      assert.equal(sessionCommands(h.bridge.calls, "resume").length, 0);
      assert.equal(h.bridge.calls.some((call) => call.command === "/bridge/agent-send.sh"), false);
    } finally { await h.cleanup(); }
  }
});

test("a delivery failure after creation fails the task instead of completing it", async () => {
  const h = await harness({ send: () => ({ code: 1, stdout: "", stderr: "ERROR: paste failed" }) });
  try {
    const { task } = await h.facade.callTask(fresh(), 2_000);
    assert.equal(task.status, "failed");
    assert.equal(task.error.code, "transport_failure");
    assert.equal(task.result, undefined);
    assert.match(task.session_id, UUID);
  } finally { await h.cleanup(); }
});

test("concurrent fresh tasks keep their own session and correlated result", async () => {
  const h = await harness({
    send: async (correlationId) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { code: 0, stdout: `result:${correlationId}`, stderr: "" };
    }
  });
  try {
    const [a, b] = await Promise.all([
      h.facade.callTask(fresh({ idempotencyKey: "a", message: "first" }), 2_000),
      h.facade.callTask(fresh({ idempotencyKey: "b", message: "second" }), 2_000)
    ]);
    assert.notEqual(a.task.session_id, b.task.session_id);
    for (const { task } of [a, b]) {
      assert.equal(task.status, "completed");
      assert.equal(task.result.text, `result:${task.task_id}`);
    }
  } finally { await h.cleanup(); }
});

test("an uncorrelated or timed-out fresh result is never reported as completed", async () => {
  const cases = [
    [{ code: 124, stdout: "", stderr: "timeout" }, "result_timeout"],
    [{ code: 66, stdout: "", stderr: "foreign markers" }, "result_uncorrelated"]
  ];
  for (const [response, code] of cases) {
    const h = await harness({ send: () => response });
    try {
      const { task } = await h.facade.callTask(fresh(), 2_000);
      assert.equal(task.status, "failed");
      assert.equal(task.error.code, code);
    } finally { await h.cleanup(); }
  }
});

test("mesh_call returns a task handle when the wait expires and mesh_task_get later reads the result", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = await harness({ createGate: gate });
  try {
    const { task } = await h.facade.callTask(fresh(), 20);
    assert.equal(task.status, "working");
    assert.match(task.session_id, UUID);
    release();
    const done = await waitForTerminal(h.facade, task.task_id);
    assert.equal(done.status, "completed");
    assert.equal(done.session_id, task.session_id);
    assert.equal(done.result.text, `reply for ${task.task_id}`);
  } finally { await h.cleanup(); }
});

test("cancelling a fresh task keeps it cancelled when the session finishes later", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = await harness({ createGate: gate });
  try {
    const { task } = await h.facade.submitTask(fresh());
    await new Promise((resolve) => setTimeout(resolve, 10));
    const cancelled = await h.facade.cancelTask(task.task_id);
    assert.equal(cancelled.status, "cancelled");
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const latest = await h.facade.getTask(task.task_id);
    assert.equal(latest.status, "cancelled");
    assert.equal(latest.result, undefined);
    assert.equal(latest.session_id, task.session_id);
  } finally { await h.cleanup(); }
});

test("a fresh task interrupted mid-flight is failed as uncertain on restart, not re-run", async () => {
  const h = await harness();
  try {
    const created = await h.store.create({
      contextId: "context-restart",
      principalId: PRINCIPAL.id,
      principalKind: PRINCIPAL.kind,
      requesterId: PRINCIPAL.requesterId,
      targetAgentId: CLAUDE,
      sessionMode: "fresh",
      sessionProvider: "claude",
      workspaceId: WORKSPACE,
      domainId: DOMAIN,
      message: "Interrupted work.",
      labels: [],
      idempotencyKey: `${PRINCIPAL.id}:restart`
    });
    await h.store.update({ ...created.task, status: "working" });
    const restarted = new MeshTaskCoordinator({ store: new MeshTaskStore({ stateDir: h.stateDir }), execute: async () => {
      throw new Error("must not execute");
    } });
    await restarted.resume();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const task = await h.store.get(created.task.task_id);
    assert.equal(task.status, "failed");
    assert.equal(task.error.code, "delivery_uncertain");
    assert.equal(h.bridge.calls.length, 0);
  } finally { await h.cleanup(); }
});

test("an existing session_id still resumes that session and never creates one", async () => {
  const h = await harness();
  const sessionId = "11111111-1111-4111-8111-111111111111";
  try {
    const { task } = await h.facade.callTask({
      targetAgentId: CLAUDE, workspaceId: WORKSPACE, domainId: DOMAIN,
      sessionId, message: "Continue.", idempotencyKey: "existing-1"
    }, 2_000);
    assert.equal(task.status, "completed", JSON.stringify(task.error));
    assert.equal(task.session_id, sessionId);
    assert.equal(task.session_mode, undefined);
    assert.equal(task.session_provenance, undefined);
    assert.deepEqual(sessionCommands(h.bridge.calls, "resume")[0].args, ["--agent", "claude", "resume", sessionId]);
    assert.equal(sessionCommands(h.bridge.calls, "new").length, 0);
  } finally { await h.cleanup(); }
});

test("a sessionless task without fresh keeps the static transport path", async () => {
  let envelope;
  const gateway = {
    async submitEnvelope(input) {
      envelope = input;
      return { envelope: input, duplicate: false, deliveries: [{ adapter_id: "tmux-transport", status: "delivered" }] };
    },
    async listAudit() {
      return [{ details: { adapter_id: "tmux-transport", adapter_details: { correlation_id: "mesh_task_static", reply: "static" } } }];
    }
  };
  const stateDir = await mkdtemp(join(tmpdir(), "agent-mesh-fresh-static-"));
  try {
    const store = new MeshTaskStore({ stateDir });
    const created = await store.create({
      contextId: "context-static",
      principalId: PRINCIPAL.id,
      principalKind: PRINCIPAL.kind,
      requesterId: PRINCIPAL.requesterId,
      targetAgentId: CLAUDE,
      workspaceId: WORKSPACE,
      domainId: DOMAIN,
      message: "Static route.",
      labels: [],
      idempotencyKey: `${PRINCIPAL.id}:static`
    });
    const task = { ...created.task, task_id: "mesh_task_static" };
    assert.equal(task.session_id, undefined);
    assert.equal(task.session_mode, undefined);
    assert.deepEqual(await executeMeshTask(gateway, task), { text: "static", artifacts: [] });
    assert.equal(envelope.metadata.session_id, undefined);
    assert.equal(envelope.metadata.session_mode, undefined);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("MCP tools advertise create_session and ignore caller-supplied shell, cwd, and binary fields", async () => {
  const h = await harness();
  try {
    const listed = await callTool(h.handler, "mesh_list_agents", {});
    const capabilities = Object.fromEntries(
      listed.structuredContent.agents.map((agent) => [agent.id, agent.capabilities])
    );
    assert.deepEqual(capabilities[CLAUDE], ["submit_request", "create_session"]);
    assert.deepEqual(capabilities[CODEX], ["submit_request"]);

    const called = await callTool(h.handler, "mesh_call", {
      target_agent_id: CLAUDE,
      workspace_id: WORKSPACE,
      domain_id: DOMAIN,
      session_mode: "fresh",
      message: "Reply with nonce XYZ",
      idempotency_key: "mcp-fresh-1",
      cwd: "/etc",
      command: "rm -rf /",
      provider_binary: "/tmp/evil",
      shell: "bash -c id",
      wait_seconds: 5
    });
    assert.equal(called.isError, undefined, JSON.stringify(called.content));
    const task = called.structuredContent.task;
    assert.equal(task.status, "completed");
    assert.equal(task.session_mode, "fresh");
    assert.equal(task.session_provenance.model, "unknown");

    const bridgeArgs = h.bridge.calls.filter((call) => call.command === "/bridge/agent-session.sh").flatMap((call) => call.args);
    for (const forbidden of ["/etc", "rm -rf /", "/tmp/evil", "bash -c id"]) {
      assert.equal(bridgeArgs.includes(forbidden), false, forbidden);
    }
    assert.equal(sessionCommands(h.bridge.calls, "new")[0].args[3], TRUSTED_CWD);
    assert.ok(h.bridge.calls.every((call) => call.command.startsWith("/bridge/")));

    const read = await callTool(h.handler, "mesh_task_get", { task_id: task.task_id });
    assert.equal(read.structuredContent.task.result.text, task.result.text);

    const rejected = await callTool(h.handler, "mesh_submit", {
      target_agent_id: CODEX, workspace_id: WORKSPACE, domain_id: DOMAIN,
      session_mode: "fresh", message: "x", idempotency_key: "mcp-codex"
    });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /^fresh_session_unsupported:/);
  } finally { await h.cleanup(); }
});

test("create_session is advertised only for workspaces the principal can use for fresh sessions", async () => {
  const h = await harness();
  try {
    const listed = (principal) => new MeshMcpFacade({
      gateway: h.gateway,
      principal,
      agents: AGENTS,
      sessionRegistry: h.sessionRegistry,
      rateLimiter: new FixedWindowMeshMcpRateLimiter()
    }).listAgents().find((agent) => agent.id === CLAUDE).capabilities;
    assert.deepEqual(listed(PRINCIPAL), ["submit_request", "create_session"]);
    assert.deepEqual(listed({ ...PRINCIPAL, allowedWorkspaceIds: [OTHER_WORKSPACE] }), ["submit_request"]);
  } finally { await h.cleanup(); }
});

test("fresh-session configuration is limited to Claude and to directories inside the workspace roots", () => {
  const base = {
    agentId: CLAUDE,
    agentType: "claude",
    agentSessionPath: "/bridge/agent-session.sh",
    agentSendPath: "/bridge/agent-send.sh",
    workspaceRoots: { [WORKSPACE]: ["/srv/workspaces/example"] },
    run: async () => { throw new Error("unexpected"); }
  };
  assert.throws(
    () => new ShellAgentSessionProvider({ ...base, agentType: "codex", freshSessionCwds: { [WORKSPACE]: TRUSTED_CWD } }),
    /not supported for agent type: codex/
  );
  assert.throws(
    () => new ShellAgentSessionProvider({ ...base, freshSessionCwds: { [WORKSPACE]: "/srv/workspaces/elsewhere" } }),
    /outside the workspace roots/
  );
  assert.throws(
    () => new ShellAgentSessionProvider({ ...base, freshSessionCwds: { [OTHER_WORKSPACE]: "/srv/workspaces/other" } }),
    /outside the workspace roots/
  );
  const provider = new ShellAgentSessionProvider({ ...base, freshSessionCwds: { [WORKSPACE]: TRUSTED_CWD } });
  const registry = new AgentSessionRegistry([provider]);
  assert.equal(registry.freshSessionSupport(CLAUDE, WORKSPACE), "supported");
  assert.equal(registry.freshSessionSupport(CLAUDE, OTHER_WORKSPACE), "workspace_unauthorized");
  assert.equal(new AgentSessionRegistry([new ShellAgentSessionProvider(base)]).supportsFreshSession(CLAUDE), false);
});
