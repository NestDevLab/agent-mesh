import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "./ts-extension-resolver.mjs";

const { TmuxTransportAdapter } = await import("../src/adapters/tmux-transport-adapter.js");
const { CapacityQueueStore } = await import("../src/core/capacity-queue-store.js");

function envelope(id, target) {
  return {
    schema: "openclaw.agent.message.v1", message_id: `message-${id}`,
    created_at: "2026-08-10T00:00:00.000Z", workspace_id: "workspace.test",
    domain_id: "domain.test", conversation_id: "conversation-test", from: "agent.parent",
    to: target, intent: "request", ttl: 3, hop_count: 0,
    idempotency_key: `run-${id}`, content: { text: `work ${id}` }
  };
}

function delivery(id, target) {
  return { id: `delivery-${id}`, message_id: `message-${id}`, adapter_id: "tmux-transport", target_agent_id: target, status: "dispatching", attempts: 1, max_attempts: 3, created_at: "2026-08-10T00:00:00.000Z", updated_at: "2026-08-10T00:00:00.000Z" };
}

const route = (target, workClass) => ({ target_agent_id: target, tmux_target: `mesh-${target}`, enable_real_send: true, capacity: { provider: "codex", harness: "codex", ...(workClass ? { workClass } : {}), observerRetryMs: 1000 } });

test("defer persists without sending and a due drain resumes exactly once", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agent-mesh-capacity-"));
  let now = Date.parse("2026-08-10T00:00:00.000Z");
  const clock = { now: () => new Date(now) };
  const decisions = ["defer", "admit"];
  const broker = { calls: [], async admit(request) { this.calls.push(request); const decision = decisions.shift(); return { decision, retryAt: decision === "defer" ? now + 1000 : null, decisionId: `decision-${this.calls.length}`, configHash: "a".repeat(64), workClass: request.workClass, concurrencyTarget: decision === "admit" ? 1 : 0, reasons: [decision === "defer" ? "over_pace" : "available"] }; } };
  const sender = { calls: [], async send(input) { this.calls.push(input); return { ok: true }; } };
  const adapter = new TmuxTransportAdapter({ sender, routes: [route("agent.worker", "L3")], capacityBroker: broker, stateDir, clock });

  const first = await adapter.dispatch(delivery("one", "agent.worker"), envelope("one", "agent.worker"));
  assert.equal(first.status, "waiting_capacity");
  assert.equal(first.details.retryAt, now + 1000);
  assert.equal(sender.calls.length, 0);
  assert.equal((await new CapacityQueueStore({ stateDir }).waiting()).length, 1);

  assert.deepEqual(await adapter.drainCapacityQueue(now), []);
  now += 1000;
  const resumed = await adapter.drainCapacityQueue(now);
  assert.equal(resumed[0].status, "delivered");
  assert.equal(sender.calls.length, 1);
  assert.equal((await new CapacityQueueStore({ stateDir }).waiting()).length, 0);
  assert.deepEqual(await adapter.drainCapacityQueue(now), []);
});

test("due queue drains in L1 then L2 then L3 order", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agent-mesh-capacity-"));
  const now = Date.parse("2026-08-10T00:00:00.000Z");
  const clock = { now: () => new Date(now) };
  let defer = true;
  const broker = { async admit(request) { return { decision: defer ? "defer" : "admit", retryAt: defer ? now : null, decisionId: `decision-${request.runId}`, configHash: "b".repeat(64), workClass: request.workClass, concurrencyTarget: 1, reasons: [defer ? "over_pace" : "available"] }; } };
  const sender = { calls: [], async send(input) { this.calls.push(input.idempotency_key); return { ok: true }; } };
  const routes = [route("agent.l3", "L3"), route("agent.l1", "L1"), route("agent.l2", "L2")];
  const adapter = new TmuxTransportAdapter({ sender, routes, capacityBroker: broker, stateDir, clock });
  for (const [id, target] of [["l3", "agent.l3"], ["l1", "agent.l1"], ["l2", "agent.l2"]]) await adapter.dispatch(delivery(id, target), envelope(id, target));
  defer = false;
  await adapter.drainCapacityQueue(now);
  assert.deepEqual(sender.calls, ["run-l1", "run-l2", "run-l3"]);
});

test("broker failure fails open only for undeclared L1", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agent-mesh-capacity-"));
  const sender = { calls: [], async send(input) { this.calls.push(input); return { ok: true }; } };
  const adapter = new TmuxTransportAdapter({ sender, routes: [route("agent.live", undefined), route("agent.background", "L2")], stateDir });
  const live = await adapter.dispatch(delivery("live", "agent.live"), envelope("live", "agent.live"));
  const background = await adapter.dispatch(delivery("background", "agent.background"), envelope("background", "agent.background"));
  assert.equal(live.status, "delivered");
  assert.equal(background.status, "waiting_capacity");
  assert.equal(sender.calls.length, 1);
  assert.deepEqual(background.details.reasons, ["capacity_broker_unavailable"]);
});
