import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const { MeshTaskCoordinator } = await import("../src/mcp/mesh-task-coordinator.ts");
const { MeshTaskStore } = await import("../src/mcp/mesh-task-store.ts");
const { MeshMcpFacade, FixedWindowMeshMcpRateLimiter, executeMeshTask } = await import(
  "../src/mcp/mesh-mcp.ts"
);

async function setup(execute = async (task) => ({ text: `reply:${task.message}` })) {
  const stateDir = await mkdtemp(join(tmpdir(), "agent-mesh-task-test-"));
  const store = new MeshTaskStore({ stateDir });
  const taskCoordinator = new MeshTaskCoordinator({ store, execute });
  const principal = {
    id: "principal-owner",
    kind: "service",
    requesterId: "agent.web_chat",
    allowedTools: ["mesh_call", "mesh_submit", "mesh_task_get", "mesh_task_cancel", "mesh_thread_get"],
    allowedAgentIds: ["agent.codex"],
    allowedWorkspaceIds: ["workspace.demo"],
    allowedDomainIds: ["domain.demo"]
  };
  const facade = new MeshMcpFacade({
    gateway: {},
    principal,
    agents: [{ id: "agent.codex", name: "Codex", provider: "codex" }],
    rateLimiter: new FixedWindowMeshMcpRateLimiter(),
    taskCoordinator
  });
  return { stateDir, store, taskCoordinator, principal, facade };
}

function input(overrides = {}) {
  return {
    targetAgentId: "agent.codex",
    contextId: "context-1",
    message: "Do bounded work.",
    idempotencyKey: "request-1",
    ...overrides
  };
}

test("mesh_call returns a durable correlated result and preserves service provenance", async () => {
  const { facade, store } = await setup();
  const output = await facade.callTask(input(), 2_000);
  assert.equal(output.duplicate, false);
  assert.equal(output.task.status, "completed");
  assert.equal(output.task.result.text, "reply:Do bounded work.");
  assert.equal(output.task.principal_kind, "service");
  assert.equal((await store.get(output.task.task_id)).message_id, output.task.message_id);
});

test("mesh_submit is idempotent per principal and rejects changed input", async () => {
  const { facade } = await setup();
  const [first, duplicate] = await Promise.all([
    facade.submitTask(input()),
    facade.submitTask(input())
  ]);
  assert.equal(first.task.task_id, duplicate.task.task_id);
  assert.equal([first.duplicate, duplicate.duplicate].filter(Boolean).length, 1);
  await assert.rejects(
    facade.submitTask(input({ message: "Different work." })),
    /idempotency key conflicts/
  );
});

test("task and thread reads are isolated to the authenticated principal", async () => {
  const { facade, taskCoordinator, principal } = await setup();
  const task = (await facade.callTask(input(), 2_000)).task;
  await assert.rejects(taskCoordinator.getOwned(task.task_id, "principal-other"), /not owned/);
  assert.deepEqual(await taskCoordinator.thread("context-1", "principal-other"), []);
  assert.equal((await taskCoordinator.thread("context-1", principal.id))[0].task_id, task.task_id);
});

test("cooperative cancellation remains terminal when a late agent result arrives", async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const { facade } = await setup(async () => pending);
  const submitted = await facade.submitTask(input());
  const cancelled = await facade.cancelTask(submitted.task.task_id);
  assert.equal(cancelled.status, "cancelled");
  finish({ text: "late result" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await facade.getTask(submitted.task.task_id)).status, "cancelled");
});

test("task store replays the latest revision after restart", async () => {
  const { facade, stateDir } = await setup();
  const completed = (await facade.callTask(input(), 2_000)).task;
  const reopened = new MeshTaskStore({ stateDir });
  assert.deepEqual(await reopened.get(completed.task_id), completed);
});

test("executeMeshTask selects the latest terminal delivery and audit reply", async () => {
  const task = {
    schema: "agent-mesh.mcp-task.v1",
    task_id: "mesh_task_1",
    context_id: "context-1",
    message_id: "mcp_1",
    principal_id: "principal-owner",
    principal_kind: "service",
    requester_id: "agent.web_chat",
    target_agent_id: "agent.codex",
    workspace_id: "workspace.demo",
    domain_id: "domain.demo",
    message: "Return evidence.",
    labels: [],
    idempotency_key: "principal-owner:request-1",
    input_hash: "hash",
    status: "working",
    created_at: "2026-08-29T12:00:00.000Z",
    updated_at: "2026-08-29T12:00:00.000Z"
  };
  const gateway = {
    async submitEnvelope(envelope) {
      assert.equal(envelope.metadata.principal_kind, "service");
      return {
        envelope,
        duplicate: true,
        deliveries: [
          { adapter_id: "tmux-transport", status: "queued" },
          { adapter_id: "tmux-transport", status: "delivered" }
        ],
        auditEventIds: []
      };
    },
    async listAudit() {
      return [{ type: "delivery.updated", details: { adapter_details: { reply: "Codex result" } } }];
    }
  };
  assert.deepEqual(await executeMeshTask(gateway, task), { text: "Codex result", artifacts: [] });
});
