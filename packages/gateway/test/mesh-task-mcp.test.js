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

test("two concurrent tasks retain distinct message, task, context, and result correlation", async () => {
  const { facade } = await setup(async (task) => {
    await new Promise((resolve) => setTimeout(resolve, task.message === "first" ? 10 : 1));
    return { text: `${task.context_id}:${task.task_id}:${task.message_id}:${task.message}` };
  });
  const [first, second] = await Promise.all([
    facade.callTask(input({ message: "first", contextId: "thread-a", idempotencyKey: "request-a" }), 2_000),
    facade.callTask(input({ message: "second", contextId: "thread-b", idempotencyKey: "request-b" }), 2_000)
  ]);
  for (const item of [first.task, second.task]) {
    assert.equal(item.status, "completed");
    assert.equal(item.result.text, `${item.context_id}:${item.task_id}:${item.message_id}:${item.message}`);
  }
  assert.notEqual(first.task.task_id, second.task.task_id);
  assert.notEqual(first.task.message_id, second.task.message_id);
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
      assert.equal(envelope.task_id, task.task_id);
      assert.equal(envelope.trace_id, task.context_id);
      assert.equal(envelope.correlation_id, task.task_id);
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
      return [{ type: "delivery.updated", details: { adapter_id: "tmux-transport", adapter_details: { correlation_id: task.task_id, reply: "Codex result" } } }];
    }
  };
  assert.deepEqual(await executeMeshTask(gateway, task), { text: "Codex result", artifacts: [] });
});

function executionTask() {
  return {
    schema: "agent-mesh.mcp-task.v1",
    task_id: "mesh_task_result_test",
    context_id: "context-result-test",
    message_id: "mcp_result_test",
    principal_id: "principal-owner",
    principal_kind: "service",
    requester_id: "agent.web_chat",
    target_agent_id: "agent.codex",
    workspace_id: "workspace.demo",
    domain_id: "domain.demo",
    message: "Return a multiline result.",
    labels: [],
    idempotency_key: "principal-owner:result-test",
    input_hash: "hash",
    status: "working",
    created_at: "2026-08-29T12:00:00.000Z",
    updated_at: "2026-08-29T12:00:00.000Z"
  };
}

function executionGateway(task, listAudit, delivery = { adapter_id: "tmux-transport", status: "delivered" }) {
  return {
    async submitEnvelope() { return { deliveries: [delivery], auditEventIds: [], duplicate: false }; },
    listAudit
  };
}

test("executeMeshTask waits for delayed persistence and preserves multiline output", async () => {
  const task = executionTask();
  let polls = 0;
  const gateway = executionGateway(task, async () => {
    polls += 1;
    return polls < 3 ? [] : [{ details: { adapter_id: "tmux-transport", adapter_details: {
      correlation_id: task.task_id,
      reply: "line one\nline two"
    } } }];
  });
  const result = await executeMeshTask(gateway, task, () => new Date(), {
    resultWaitMs: 100,
    resultPollMs: 1,
    sleep: async () => undefined
  });
  assert.equal(polls, 3);
  assert.equal(result.text, "line one\nline two");
});

test("executeMeshTask distinguishes empty, uncorrelated, parsing, timeout, and transport failures", async () => {
  const task = executionTask();
  const correlated = (adapter_details) => [{ details: { adapter_id: "tmux-transport", adapter_details } }];
  const cases = [
    [correlated({ correlation_id: task.task_id, reply: "" }), "result_no_output"],
    [correlated({ correlation_id: "mesh_task_wrong", reply: "wrong task" }), "result_uncorrelated"],
    [correlated({ correlation_id: task.task_id, result_error_code: "result_parsing_failure", result_error: "bad markers" }), "result_parsing_failure"],
    [[], "result_timeout"]
  ];
  for (const [audits, code] of cases) {
    await assert.rejects(
      executeMeshTask(executionGateway(task, async () => audits), task, () => new Date(), { resultWaitMs: 0 }),
      (error) => error.code === code
    );
  }
  await assert.rejects(
    executeMeshTask(executionGateway(task, async () => [], { adapter_id: "tmux-transport", status: "failed" }), task),
    (error) => error.code === "transport_failure"
  );
});

test("coordinator persists a typed result error instead of generic agent_execution_failed", async () => {
  const typed = Object.assign(new Error("bad result markers"), { code: "result_parsing_failure" });
  const { facade } = await setup(async () => { throw typed; });
  const completed = (await facade.callTask(input(), 2_000)).task;
  assert.equal(completed.status, "failed");
  assert.equal(completed.error.code, "result_parsing_failure");
});
