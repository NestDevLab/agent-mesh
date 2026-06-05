import assert from "node:assert/strict";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const { planDiscordDelivery } = await import("../src/core/discord-delivery-planner.ts");
const { DiscordDeliveryPlanStore } = await import("../src/core/discord-delivery-plan-store.ts");

const fixedClock = {
  now() {
    return new Date("2026-05-10T17:20:00.000Z");
  }
};

test("denies secret unredacted Discord delivery plans", () => {
  const plan = planDiscordDelivery(
    request({
      sensitivity: "secret",
      redaction_state: "none"
    }),
    { clock: fixedClock }
  );

  assert.equal(plan.decision, "deny");
  assert.equal(plan.status, "denied_stubbed");
  assert.match(plan.reason, /Secret Discord payloads are denied/);
  assert.ok(plan.risk_flags.includes("secret-unredacted"));
  assertNoRealAdapterCall(plan);
});

test("asks human for private Discord delivery plans", () => {
  const plan = planDiscordDelivery(
    request({
      sensitivity: "private",
      redaction_state: "redacted"
    }),
    { clock: fixedClock }
  );

  assert.equal(plan.decision, "ask-human");
  assert.equal(plan.status, "requires_human_stubbed");
  assert.ok(plan.risk_flags.includes("private-requires-human"));
  assertNoRealAdapterCall(plan);
});

test("asks human for confidential Discord delivery plans", () => {
  const plan = planDiscordDelivery(
    request({
      sensitivity: "confidential",
      redaction_state: "redacted"
    }),
    { clock: fixedClock }
  );

  assert.equal(plan.decision, "ask-human");
  assert.equal(plan.status, "requires_human_stubbed");
  assert.ok(plan.risk_flags.includes("confidential-requires-human"));
  assertNoRealAdapterCall(plan);
});

test("accepts internal redacted Discord delivery plans in dry-run only", () => {
  const plan = planDiscordDelivery(
    request({
      sensitivity: "internal",
      redaction_state: "redacted"
    }),
    { clock: fixedClock }
  );

  assert.equal(plan.decision, "allow-dry-run");
  assert.equal(plan.status, "planned_stubbed");
  assert.equal(plan.dry_run, true);
  assert.equal(plan.no_external_send, true);
  assert.equal(plan.visibility, "internal");
  assert.match(plan.idempotency_key, /^discord_delivery_plan:/);
  assertNoRealAdapterCall(plan);
});

test("records Discord delivery plans in the local NDJSON store", async () => {
  const stateDir = await createStateDir();
  const store = new DiscordDeliveryPlanStore({ stateDir, clock: fixedClock });
  const plan = planDiscordDelivery(
    request({
      sensitivity: "internal",
      redaction_state: "redacted",
      idempotency_key: "idem-discord-store-1"
    }),
    { clock: fixedClock }
  );

  await store.append(plan);
  const records = await store.list();

  assert.equal(records.length, 1);
  assert.equal(records[0].id, plan.id);
  assert.equal(records[0].idempotency_key, "idem-discord-store-1");
  assertNoRealAdapterCall(records[0]);
});

function request(overrides = {}) {
  return {
    message_kind: "approval_request",
    workspace_id: "workspace.the operator",
    domain_id: "domain.nestdev",
    conversation_id: "conversation-1",
    source_event_id: "audit-1",
    source_message_id: "msg-1",
    target: {
      surface: "discord",
      guild_id: "guild-1",
      channel_id: "channel-1",
      thread_id: "thread-1",
      route_policy_id: "route.internal"
    },
    content: {
      title: "Approval needed",
      body: "Redacted dry-run summary"
    },
    dry_run: true,
    no_external_send: true,
    ...overrides
  };
}

function assertNoRealAdapterCall(plan) {
  assert.deepEqual(plan.adapter_flags, {
    discord_adapter_called: false,
    openclaw_message_tool_called: false,
    discord_objects_mutated: false
  });
}

async function createStateDir() {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return mkdtemp(join(tmpdir(), "agent-mesh-discord-plan-"));
}
