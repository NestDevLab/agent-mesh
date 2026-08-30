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
    workspace_id: "workspace.the operator",
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
  assert.equal(sender.calls[0].message_id, "msg-1");
  assert.equal(sender.calls[0].context_id, "conv-1");
  assert.equal(sender.calls[0].correlation_id, "corr-1");
  assert.match(sender.calls[0].prompt, /review the failing test/i);
});

test("records result collection failure without changing delivered transport status", async () => {
  const stateDir = await freshStateDir();
  const adapter = new TmuxTransportAdapter({
    sender: fakeSender({ ok: true, result_error_code: "result_uncorrelated", error: "wrong marker" }),
    routes: realSendRoute,
    stateDir,
    clock: fixedClock
  });

  const result = await adapter.dispatch(baseDelivery(), baseEnvelope());

  assert.equal(result.status, "delivered");
  assert.equal(result.details.result_error_code, "result_uncorrelated");
  assert.equal(result.details.result_error, "wrong marker");
});

test("rejects MCP ingress unless the exact tmux route opts in", async () => {
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
    baseEnvelope({ metadata: { ingress: "mcp" } })
  );

  assert.equal(result.status, "failed");
  assert.equal(result.details.reason, "mcp_ingress_not_allowed");
  assert.equal(sender.calls.length, 0);
});

test("allows MCP ingress only on an explicitly opted-in route", async () => {
  const stateDir = await freshStateDir();
  const sender = fakeSender();
  const adapter = new TmuxTransportAdapter({
    sender,
    routes: [{ ...realSendRoute[0], allow_mcp_ingress: true }],
    stateDir,
    clock: fixedClock
  });

  const result = await adapter.dispatch(
    baseDelivery(),
    baseEnvelope({ metadata: { ingress: "mcp" } })
  );

  assert.equal(result.status, "delivered");
  assert.equal(sender.calls.length, 1);
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

// ── Regression coverage from Codex's review (failure paths + gaps) ───────────

test("sender result {ok:false} returns failed WITH reason and tmux_target", async () => {
  const stateDir = await freshStateDir();
  const sender = fakeSender({ ok: false, error: "pane_busy" });
  const adapter = new TmuxTransportAdapter({
    sender,
    routes: realSendRoute,
    stateDir,
    clock: fixedClock
  });

  const result = await adapter.dispatch(baseDelivery(), baseEnvelope());

  assert.equal(result.status, "failed");
  assert.equal(result.details.reason, "pane_busy");
  assert.equal(result.details.tmux_target, "mesh-codex-main");
});

test("sender throwing returns failed WITH reason and tmux_target", async () => {
  const stateDir = await freshStateDir();
  const sender = {
    calls: [],
    async send() {
      throw new Error("tmux socket gone");
    }
  };
  const adapter = new TmuxTransportAdapter({
    sender,
    routes: realSendRoute,
    stateDir,
    clock: fixedClock
  });

  const result = await adapter.dispatch(baseDelivery(), baseEnvelope());

  assert.equal(result.status, "failed");
  assert.equal(result.details.reason, "tmux socket gone");
  assert.equal(result.details.tmux_target, "mesh-codex-main");
});

test("failure paths still record an audit event (anti-loop and no-route)", async () => {
  const stateDir = await freshStateDir();
  const adapter = new TmuxTransportAdapter({
    sender: fakeSender(),
    routes: [],
    stateDir,
    clock: fixedClock
  });

  await adapter.dispatch(baseDelivery(), baseEnvelope()); // no route -> failed

  const store = new TmuxDispatchStore({ stateDir });
  const records = await store.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "failed");
  assert.equal(records[0].reason, "no_route_for_target");
  assert.equal(records[0].sender_called, false);
});

test("preserves causation_id through to result and audit", async () => {
  const stateDir = await freshStateDir();
  const adapter = new TmuxTransportAdapter({
    sender: fakeSender(),
    routes: realSendRoute,
    stateDir,
    clock: fixedClock
  });

  const result = await adapter.dispatch(
    baseDelivery(),
    baseEnvelope({ causation_id: "cause-1" })
  );

  assert.equal(result.details.causation_id, "cause-1");
  const records = await new TmuxDispatchStore({ stateDir }).list();
  assert.equal(records[0].causation_id, "cause-1");
});

test("renders prompt from content.summary when text is absent", async () => {
  const stateDir = await freshStateDir();
  const sender = fakeSender();
  const adapter = new TmuxTransportAdapter({
    sender,
    routes: realSendRoute,
    stateDir,
    clock: fixedClock
  });

  await adapter.dispatch(
    baseDelivery(),
    baseEnvelope({ content: { summary: "fallback summary text" } })
  );

  assert.equal(sender.calls[0].prompt, "fallback summary text");
});

test("renders prompt as JSON when neither text nor summary present", async () => {
  const stateDir = await freshStateDir();
  const sender = fakeSender();
  const adapter = new TmuxTransportAdapter({
    sender,
    routes: realSendRoute,
    stateDir,
    clock: fixedClock
  });

  await adapter.dispatch(
    baseDelivery(),
    baseEnvelope({ content: { foo: "bar" } })
  );

  assert.equal(sender.calls[0].prompt, JSON.stringify({ foo: "bar" }));
});

test("concurrent same-key dispatches send exactly once (atomic claim)", async () => {
  const stateDir = await freshStateDir();
  // Sender that defers, so both dispatches overlap in-flight.
  let calls = 0;
  const sender = {
    async send() {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, reply: "ok" };
    }
  };
  const adapter = new TmuxTransportAdapter({
    sender,
    routes: realSendRoute,
    stateDir,
    clock: fixedClock
  });

  const [a, b] = await Promise.all([
    adapter.dispatch(baseDelivery(), baseEnvelope()),
    adapter.dispatch(baseDelivery(), baseEnvelope())
  ]);

  assert.equal(calls, 1, "sender must be called exactly once");
  const statuses = [a.status, b.status].sort();
  // one real send + one deduped/suppressed concurrent attempt
  assert.ok(a.details.deduplicated === true || b.details.deduplicated === true);
  assert.ok(statuses.includes("delivered") || statuses.includes("stubbed"));
});

test("claim is released on failure so a later retry can send again", async () => {
  const stateDir = await freshStateDir();
  let calls = 0;
  const sender = {
    async send() {
      calls += 1;
      // fail the first attempt, succeed the second
      return calls === 1 ? { ok: false, error: "pane_busy" } : { ok: true, reply: "ok" };
    }
  };
  const adapter = new TmuxTransportAdapter({
    sender,
    routes: realSendRoute,
    stateDir,
    clock: fixedClock
  });

  const first = await adapter.dispatch(baseDelivery(), baseEnvelope());
  const second = await adapter.dispatch(baseDelivery(), baseEnvelope());

  assert.equal(first.status, "failed");
  assert.equal(second.status, "delivered");
  assert.equal(calls, 2, "retry after a failed send must reach the sender again");
});

test("a prior STUBBED record dedups a later enabled send (contract-consistent)", async () => {
  const stateDir = await freshStateDir();
  const sender = fakeSender();
  // First dispatch on a stub route records a stubbed entry for idem-1.
  const stubAdapter = new TmuxTransportAdapter({
    sender,
    routes: stubRoute,
    stateDir,
    clock: fixedClock
  });
  const stubbed = await stubAdapter.dispatch(baseDelivery(), baseEnvelope());
  assert.equal(stubbed.status, "stubbed");

  // A later enabled route with the SAME idempotency_key must NOT send: the
  // stubbed record (non-failed) suppresses it. This pins the documented
  // ordering (idempotency runs before the dry-run gate).
  const enabledAdapter = new TmuxTransportAdapter({
    sender,
    routes: realSendRoute,
    stateDir,
    clock: fixedClock
  });
  const second = await enabledAdapter.dispatch(baseDelivery(), baseEnvelope());

  assert.equal(sender.calls.length, 0);
  assert.equal(second.details.deduplicated, true);
});
