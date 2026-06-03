import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "./ts-extension-resolver.mjs";

const { TmuxTransportAdapter } = await import(
  "../src/adapters/tmux-transport-adapter.js"
);
const { TmuxDispatchStore } = await import(
  "../src/core/tmux-dispatch-store.js"
);

const fixedClock = { now: () => new Date("2026-06-03T12:00:00.000Z") };

function fakeSender(result = { ok: true, reply: "ack" }) {
  return {
    calls: [],
    async send(input) {
      this.calls.push(input);
      return result;
    }
  };
}

function baseEnvelope(overrides = {}) {
  return {
    schema: "openclaw.agent.message.v1",
    message_id: "msg-1",
    created_at: "2026-06-03T11:59:00.000Z",
    workspace_id: "workspace.joseph",
    domain_id: "domain.nestdev",
    conversation_id: "conv-1",
    from: "agent.chief_of_staff",
    to: "agent.software_engineer",
    intent: "request",
    ttl: 3,
    hop_count: 0,
    idempotency_key: "idem-1",
    content: { text: "Please review the failing test." },
    trace_id: "trace-1",
    correlation_id: "corr-1",
    ...overrides
  };
}

function baseDelivery(overrides = {}) {
  return {
    id: "delivery-1",
    message_id: "msg-1",
    adapter_id: "tmux-transport",
    target_agent_id: "agent.software_engineer",
    status: "dispatching",
    attempts: 1,
    max_attempts: 3,
    created_at: "2026-06-03T11:59:30.000Z",
    updated_at: "2026-06-03T11:59:30.000Z",
    ...overrides
  };
}

const realSendRoute = [
  {
    target_agent_id: "agent.software_engineer",
    tmux_target: "mesh-codex-main",
    enable_real_send: true
  }
];

const stubRoute = [
  {
    target_agent_id: "agent.software_engineer",
    tmux_target: "mesh-codex-main"
  }
];

async function freshStateDir() {
  return mkdtemp(join(tmpdir(), "agent-mesh-tmux-"));
}

test("exposes the tmux-transport id and implements dispatch", () => {
  const adapter = new TmuxTransportAdapter({
    sender: fakeSender(),
    routes: stubRoute
  });
  assert.equal(adapter.id, "tmux-transport");
  assert.equal(typeof adapter.dispatch, "function");
});

test("stubs by default and does NOT call the sender (dry-run-first)", async () => {
  const stateDir = await freshStateDir();
  const sender = fakeSender();
  const adapter = new TmuxTransportAdapter({
    sender,
    routes: stubRoute,
    stateDir,
    clock: fixedClock
  });

  const result = await adapter.dispatch(baseDelivery(), baseEnvelope());

  assert.equal(result.status, "stubbed");
  assert.equal(sender.calls.length, 0);
  assert.ok(result.external_id);
});

test("calls the sender once and returns delivered for an enabled route", async () => {
  const stateDir = await freshStateDir();
  const sender = fakeSender({ ok: true, reply: "done" });
  const adapter = new TmuxTransportAdapter({
    sender,
    routes: realSendRoute,
    stateDir,
    clock: fixedClock
  });

  const result = await adapter.dispatch(baseDelivery(), baseEnvelope());

  assert.equal(result.status, "delivered");
  assert.equal(sender.calls.length, 1);
  assert.equal(sender.calls[0].tmux_target, "mesh-codex-main");
  assert.equal(sender.calls[0].target_agent_id, "agent.software_engineer");
  assert.match(sender.calls[0].prompt, /review the failing test/i);
});

test("records an audit event to the store", async () => {
  const stateDir = await freshStateDir();
  const adapter = new TmuxTransportAdapter({
    sender: fakeSender(),
    routes: realSendRoute,
    stateDir,
    clock: fixedClock
  });

  await adapter.dispatch(baseDelivery(), baseEnvelope());

  const store = new TmuxDispatchStore({ stateDir });
  const records = await store.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].adapter_id, "tmux-transport");
  assert.equal(records[0].status, "delivered");
  assert.equal(records[0].sender_called, true);
  assert.equal(records[0].idempotency_key, "idem-1");
});

test("rejects via anti-loop (ttl exhausted) without calling the sender", async () => {
  const stateDir = await freshStateDir();
  const sender = fakeSender();
  const adapter = new TmuxTransportAdapter({
    sender,
    routes: realSendRoute,
    stateDir,
    clock: fixedClock
  });

  const result = await adapter.dispatch(
    baseDelivery(),
    baseEnvelope({ hop_count: 3, ttl: 3 })
  );

  assert.equal(result.status, "failed");
  assert.equal(sender.calls.length, 0);
  assert.equal(result.details.reason, "ttl_exhausted");
});

test("is idempotent: same idempotency_key does not re-call the sender", async () => {
  const stateDir = await freshStateDir();
  const sender = fakeSender();
  const adapter = new TmuxTransportAdapter({
    sender,
    routes: realSendRoute,
    stateDir,
    clock: fixedClock
  });

  const first = await adapter.dispatch(baseDelivery(), baseEnvelope());
  const second = await adapter.dispatch(baseDelivery(), baseEnvelope());

  assert.equal(first.status, "delivered");
  assert.equal(sender.calls.length, 1);
  assert.equal(second.details.deduplicated, true);
});

test("fails when no route exists for the target agent", async () => {
  const stateDir = await freshStateDir();
  const sender = fakeSender();
  const adapter = new TmuxTransportAdapter({
    sender,
    routes: [],
    stateDir,
    clock: fixedClock
  });

  const result = await adapter.dispatch(baseDelivery(), baseEnvelope());

  assert.equal(result.status, "failed");
  assert.equal(sender.calls.length, 0);
  assert.equal(result.details.reason, "no_route_for_target");
});

test("preserves trace and correlation ids in the dispatch result", async () => {
  const stateDir = await freshStateDir();
  const adapter = new TmuxTransportAdapter({
    sender: fakeSender(),
    routes: realSendRoute,
    stateDir,
    clock: fixedClock
  });

  const result = await adapter.dispatch(baseDelivery(), baseEnvelope());

  assert.equal(result.details.trace_id, "trace-1");
  assert.equal(result.details.correlation_id, "corr-1");
  assert.equal(result.details.target_agent_id, "agent.software_engineer");
});
