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
  assert.equal(await provider.deliverNotice(notice), "queued");
  assert.ok(invocations[0].includes("--delivery-only")); assert.ok(invocations[0].includes("--resume"));
  mode = "accepted"; assert.equal(await provider.deliverNotice(notice), "delivered");
  mode = "error"; assert.equal(await provider.deliverNotice(notice), "uncertain");
});
