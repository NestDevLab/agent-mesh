import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./ts-extension-resolver.mjs";

const { MeshTaskCoordinator } = await import("../src/mcp/mesh-task-coordinator.ts");
const { MeshTaskStore } = await import("../src/mcp/mesh-task-store.ts");
const { MeshMcpFacade, FixedWindowMeshMcpRateLimiter } = await import("../src/mcp/mesh-mcp.ts");

const route = { agent_id: "agent.sender", session_id: "11111111-1111-4111-8111-111111111111", workspace_id: "workspace.demo", resume: true };
const target = "22222222-2222-4222-8222-222222222222";
const principal = { id: "principal.demo", kind: "service", requesterId: "agent.requester", allowedTools: ["mesh_submit", "mesh_task_get"],
  allowedAgentIds: ["agent.sender", "agent.worker"], allowedWorkspaceIds: ["workspace.demo"], allowedDomainIds: ["domain.demo"], returnRoutes: [route] };
const input = { targetAgentId: "agent.worker", sessionId: target, message: "Do the work.", idempotencyKey: "task-one", returnRoute: { agentId: route.agent_id, sessionId: route.session_id } };
const sessionRegistry = { has: () => true, async get(agent, { sessionId, workspaceId }) { return { agent_id: agent, session_id: sessionId, workspace_id: workspaceId, provider: "codex" }; } };
async function setup(execute, deliverReturn) {
  const stateDir = await mkdtemp(join(tmpdir(), "mesh-return-"));
  const store = new MeshTaskStore({ stateDir });
  const coordinator = new MeshTaskCoordinator({ store, execute, deliverReturn });
  const facade = new MeshMcpFacade({ gateway: {}, principal, agents: [{ id: "agent.sender", name: "sender", provider: "codex" }, { id: "agent.worker", name: "worker", provider: "codex" }],
    rateLimiter: new FixedWindowMeshMcpRateLimiter(), taskCoordinator: coordinator, sessionRegistry });
  return { stateDir, store, coordinator, facade };
}
async function eventually(fn) {
  for (let n = 0; n < 100; n++) { const value = await fn(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.fail("condition did not become true");
}

test("terminal result is durable, with one return per task and no progress callback", async () => {
  let finish; const work = new Promise((resolve) => { finish = resolve; }); const calls = [];
  const { facade, store } = await setup(() => work, async (task) => { calls.push(task.return_delivery.id); return "delivered"; });
  const task = (await facade.submitTask(input)).task;
  await eventually(async () => (await store.get(task.task_id)).status === "working");
  assert.equal(calls.length, 0);
  finish({ text: "untrusted result text" });
  const done = await eventually(async () => { const t = await store.get(task.task_id); return t.return_delivery?.status === "delivered" && t; });
  assert.equal(done.result.text, "untrusted result text"); assert.deepEqual(calls, [`terminal:${task.task_id}`]);
  assert.equal((await facade.submitTask(input)).duplicate, true);
});

test("failure yields a terminal return; a task without route has none", async () => {
  const calls = []; const { facade, store } = await setup(async () => { throw new Error("fixture failure"); }, async (task) => { calls.push(task.task_id); return "queued"; });
  const first = (await facade.submitTask(input)).task;
  const second = (await facade.submitTask({ ...input, returnRoute: undefined, idempotencyKey: "task-two" })).task;
  await eventually(async () => (await store.get(first.task_id)).return_delivery?.status === "queued");
  const noRoute = await eventually(async () => { const t = await store.get(second.task_id); return t.status === "failed" && t; });
  assert.equal(noRoute.return_delivery, undefined); assert.deepEqual(calls, [first.task_id]);
});

test("restart recovers pending and uncertain returns with the same correlation", async () => {
  const calls = []; const { facade, stateDir, store } = await setup(async () => ({ text: "result" }), async (task) => { calls.push(task.return_delivery.id); return "uncertain"; });
  const task = (await facade.submitTask(input)).task;
  await eventually(async () => (await store.get(task.task_id)).return_delivery?.status === "uncertain");
  const reopened = new MeshTaskStore({ stateDir });
  const coordinator = new MeshTaskCoordinator({ store: reopened, execute: async () => { throw new Error("must not rerun terminal task"); }, deliverReturn: async (t) => { calls.push(t.return_delivery.id); return "delivered"; } });
  await coordinator.resume();
  await eventually(async () => (await reopened.get(task.task_id)).return_delivery?.status === "delivered");
  assert.deepEqual(calls, [`terminal:${task.task_id}`, `terminal:${task.task_id}`]);
});

test("unbound or foreign return session is rejected before task creation", async () => {
  const { facade, store } = await setup(async () => ({ text: "unused" }), async () => "delivered");
  await assert.rejects(facade.submitTask({ ...input, returnRoute: { agentId: route.agent_id, sessionId: target } }), /not uniquely bound/);
  await assert.rejects(facade.submitTask({ ...input, returnRoute: { agentId: route.agent_id, sessionId: route.session_id }, workspaceId: "workspace.other" }), /not allowed/);
  assert.deepEqual(await store.list(), []);
});

const { ShellAgentSessionProvider } = await import("../src/adapters/agent-session-provider.ts");
test("native return uses delivery-only, respects resume policy, and distinguishes held, accepted and uncertain", async () => {
  let mode = "held"; const invocations = [];
  const provider = new ShellAgentSessionProvider({ agentId: "agent.sender", agentType: "codex", agentSessionPath: "/fixture/session", agentSendPath: "/fixture/send", agentNativeCallPath: "/fixture/native", workspaceRoots: { "workspace.demo": ["/fixture"] },
    run: async (_command, args) => {
      invocations.push(args);
      if (mode === "error") return { code: 1, stdout: "", stderr: "unknown delivery" };
      return { code: 0, stderr: "", stdout: JSON.stringify({ agent: "codex", sessionId: route.session_id, correlationId: "terminal:one", status: mode === "held" ? "queued" : "delivered", held: true }) };
    } });
  provider.get = async () => ({ session_id: route.session_id, workspace_id: route.workspace_id, provider: "codex" });
  const notice = { sessionId: route.session_id, workspaceId: route.workspace_id, correlationId: "terminal:one", message: "result data", resume: true };
  assert.equal(await provider.deliverNotice(notice), "held");
  assert.ok(invocations[0].includes("--delivery-only")); assert.ok(invocations[0].includes("--resume"));
  mode = "accepted"; assert.equal(await provider.deliverNotice(notice), "queued");
  mode = "error"; assert.equal(await provider.deliverNotice(notice), "uncertain");
});

test("Claude return uses its managed inbox and respects held gate without resume", async () => {
  const requests = [];
  let state = "held";
  const provider = new ShellAgentSessionProvider({ agentId: "agent.sender", agentType: "claude", agentSessionPath: "/fixture/session", agentSendPath: "/fixture/send", agentNativeCallPath: "/fixture/native", agentManagedInboxRoot: "/fixture/inbox", workspaceRoots: { "workspace.demo": ["/fixture"] },
    run: async (_command, args) => {
      requests.push(args);
      const receipt = { agent: "claude", sessionId: route.session_id, correlationId: "terminal:claude" };
      return { code: 0, stderr: "", stdout: JSON.stringify(state === "held"
        ? { ...receipt, status: "queued", held: true }
        : { ...receipt, status: "queued" }) };
    } });
  provider.get = async () => ({ session_id: route.session_id, workspace_id: route.workspace_id, provider: "claude" });
  const notice = { sessionId: route.session_id, workspaceId: route.workspace_id, correlationId: "terminal:claude", message: "terminal data", resume: false };
  assert.equal(await provider.deliverNotice(notice), "held");
  assert.ok(requests[0].includes("--delivery-only"));
  assert.equal(requests[0][requests[0].indexOf("--managed-inbox-root") + 1], "/fixture/inbox");
  assert.ok(!requests[0].includes("--resume"));
  state = "accepted";
  assert.equal(await provider.deliverNotice(notice), "queued");
  assert.equal(await provider.deliverNotice({ ...notice, resume: true }), "uncertain");
  assert.equal(requests.length, 2);
});

test("Claude return fails closed without a configured managed inbox", async () => {
  let calls = 0;
  const provider = new ShellAgentSessionProvider({ agentId: "agent.sender", agentType: "claude", agentSessionPath: "/fixture/session", agentSendPath: "/fixture/send", agentNativeCallPath: "/fixture/native", workspaceRoots: { "workspace.demo": ["/fixture"] },
    run: async () => { calls++; throw new Error("must not send"); } });
  assert.equal(await provider.deliverNotice({ sessionId: route.session_id, workspaceId: route.workspace_id, correlationId: "terminal:claude", message: "result", resume: false }), "uncertain");
  assert.equal(calls, 0);
});

test("a bound Claude sender receives a held return for an existing Codex target", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "mesh-claude-return-"));
  const store = new MeshTaskStore({ stateDir });
  const claudeRoute = { ...route, resume: false };
  const transportCalls = [];
  const provider = new ShellAgentSessionProvider({ agentId: route.agent_id, agentType: "claude", agentSessionPath: "/fixture/session", agentSendPath: "/fixture/send", agentNativeCallPath: "/fixture/native", agentManagedInboxRoot: "/fixture/inbox", workspaceRoots: { "workspace.demo": ["/fixture"] },
    run: async (_command, args) => {
      transportCalls.push(args);
      return { code: 0, stderr: "", stdout: JSON.stringify({ agent: "claude", sessionId: route.session_id, correlationId: args[args.indexOf("--correlation-id") + 1], held: true, status: "queued" }) };
    } });
  provider.get = async () => ({ session_id: route.session_id, workspace_id: route.workspace_id, provider: "claude" });
  const coordinator = new MeshTaskCoordinator({ store, execute: async () => ({ text: "terminal result" }), deliverReturn: async (task) => provider.deliverNotice({ sessionId: task.return_route.session_id, workspaceId: task.return_route.workspace_id, correlationId: task.return_delivery.id, message: task.result.text, resume: task.return_route.resume }) });
  const registry = { has: () => true, async get(agent, { sessionId, workspaceId }) { return { agent_id: agent, session_id: sessionId, workspace_id: workspaceId, provider: agent === route.agent_id ? "claude" : "codex" }; } };
  const facade = new MeshMcpFacade({ gateway: {}, principal: { ...principal, returnRoutes: [claudeRoute] }, agents: [{ id: "agent.sender", name: "sender", provider: "claude" }, { id: "agent.worker", name: "worker", provider: "codex" }],
    rateLimiter: new FixedWindowMeshMcpRateLimiter(), taskCoordinator: coordinator, sessionRegistry: registry });
  const task = (await facade.submitTask(input)).task;
  const terminal = await eventually(async () => { const t = await store.get(task.task_id); return t.return_delivery?.status === "held" && t; });
  assert.equal(terminal.status, "completed");
  assert.equal(transportCalls.length, 1);
  assert.ok(!transportCalls[0].includes("--resume"));
});

const { terminalReturnObserved, reconcileTerminalReturn } = await import("../src/mcp/serve.ts");
const { cloudflarePrincipalId } = await import("../src/mcp/cloudflare-access.ts");
test("native transcript observation verifies exact Codex text or Claude inbox envelope", () => {
  const message = "Terminal result data", id = "terminal:fixture";
  const wrapped = (changes = {}) => "AGENT_MESH_INBOX " + JSON.stringify({ schema: "agent-mesh.monitor-inbox.v1", deliveryId: id, prompt: message, ...changes });
  assert.equal(terminalReturnObserved({ role: "user", text: message }, "codex", message, id), true);
  assert.equal(terminalReturnObserved({ role: "user", text: message }, "claude", message, id), true);
  assert.equal(terminalReturnObserved({ role: "user", text: wrapped() }, "claude", message, id), true);
  for (const [event, provider] of [
    [{ role: "assistant", text: wrapped() }, "claude"],
    [{ role: "user", text: wrapped({ deliveryId: "other" }) }, "claude"],
    [{ role: "user", text: wrapped({ prompt: "different" }) }, "claude"],
    [{ role: "user", text: wrapped({ schema: "other" }) }, "claude"],
    [{ role: "user", text: wrapped().slice(0, -1) }, "claude"],
    [{ role: "user", text: wrapped() }, "codex"]
  ]) assert.equal(terminalReturnObserved(event, provider, message, id), false);
});

for (const provider of ["codex", "claude"]) test(`${provider} receipts distinguish held, native queue and transcript observation`, async () => {
  const configuredRoute = { ...route, resume: provider === "codex" };
  const binding = { kind: "service", selector: "service.fixture", returnRoutes: [configuredRoute] };
  const task = { task_id: "mesh_task_fixture", context_id: "context.fixture", principal_id: cloudflarePrincipalId(binding.kind, binding.selector),
    workspace_id: route.workspace_id, status: "completed", result: { text: "not instructions", artifacts: [] }, return_route: configuredRoute,
    return_delivery: { id: "terminal:fixture", status: "pending" } };
  let sent = 0, status = "held", seen = false, captured = "";
  const registry = {
    async get(_agent, request) { return { session_id: request.sessionId, workspace_id: request.workspaceId, provider }; },
    async transcript() { return { events: seen ? [{ role: "user", text: captured }] : [], next_cursor: null }; },
    async deliverNotice(_agent, request) { sent++; captured = request.message; assert.equal(request.correlationId, task.return_delivery.id); return status; }
  };
  assert.equal(await reconcileTerminalReturn(task, [binding], registry), "held");
  assert.equal(sent, 1);
  assert.equal(JSON.parse(captured.split("\n").slice(1).join("\n")).result.text, "not instructions");
  task.return_delivery.status = "held"; status = "queued";
  assert.equal(await reconcileTerminalReturn(task, [binding], registry), "queued");
  assert.equal(sent, 2);
  task.return_delivery.status = "queued";
  assert.equal(await reconcileTerminalReturn(task, [binding], registry), "queued");
  assert.equal(sent, 2, "native acceptance must not trigger another send");
  task.return_delivery.status = "uncertain";
  assert.equal(await reconcileTerminalReturn(task, [binding], registry), "uncertain");
  assert.equal(sent, 2, "uncertain delivery must only be observed");
  seen = true;
  assert.equal(await reconcileTerminalReturn(task, [binding], registry), "delivered");
  assert.equal(sent, 2);
  assert.equal(await reconcileTerminalReturn(task, [{ ...binding, returnRoutes: [] }], registry), "uncertain");
  assert.equal(sent, 2);
});
