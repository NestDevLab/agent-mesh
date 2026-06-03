import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const { ControlledDiscordAdapter } = await import(
  "../src/adapters/controlled-discord-adapter.ts"
);
const { DiscordSendAttemptStore } = await import(
  "../src/core/discord-send-attempt-store.ts"
);
const { planDiscordDelivery } = await import("../src/core/discord-delivery-planner.ts");
const { validateDiscordSendAttemptRecord } = await import(
  "../src/schema/discord-send-attempt.ts"
);

const fixedClock = {
  now() {
    return new Date("2026-05-10T18:05:00.000Z");
  }
};

test("calls injected sender exactly once for an approved configured real send", async () => {
  const sender = fakeSender();
  const stateDir = await mkdtemp(join(tmpdir(), "agent-mesh-discord-send-"));
  const store = new DiscordSendAttemptStore({ stateDir, clock: fixedClock });
  const adapter = new ControlledDiscordAdapter({ sender, attemptStore: store, clock: fixedClock });

  const input = approvedInput();
  const frozenPlanSnapshot = JSON.stringify(input.delivery_plan);
  const attempt = await adapter.send(input);

  assert.equal(sender.calls.length, 1);
  assert.equal(attempt.status, "sent");
  assert.equal(attempt.sender_called, true);
  assert.equal(attempt.sender_call_count, 1);
  assert.equal(attempt.openclaw_message_tool_called, false);
  assert.equal(attempt.discord_message_id, "discord-message-1");
  assert.equal(validateDiscordSendAttemptRecord(attempt).ok, true);
  assert.equal(JSON.stringify(input.delivery_plan), frozenPlanSnapshot);

  const records = await store.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "sent");
});

test("does not call sender when real send is not explicitly enabled", async () => {
  const sender = fakeSender();
  const adapter = new ControlledDiscordAdapter({ sender, clock: fixedClock });

  const attempt = await adapter.send(approvedInput({ enable_real_send: false }));

  assert.equal(sender.calls.length, 0);
  assert.equal(attempt.status, "denied");
  assert.match(attempt.reason, /enable_real_send/);
});

test("does not call sender for deny policy decisions", async () => {
  const sender = fakeSender();
  const adapter = new ControlledDiscordAdapter({ sender, clock: fixedClock });
  const input = approvedInput({
    policy_decision: policyDecision({ decision: "deny" })
  });

  const attempt = await adapter.send(input);

  assert.equal(sender.calls.length, 0);
  assert.equal(attempt.status, "denied");
  assert.match(attempt.reason, /allow-once policy decision/);
});

test("does not call sender for ask-human policy decisions", async () => {
  const sender = fakeSender();
  const adapter = new ControlledDiscordAdapter({ sender, clock: fixedClock });
  const input = approvedInput({
    policy_decision: policyDecision({ decision: "ask-human" })
  });

  const attempt = await adapter.send(input);

  assert.equal(sender.calls.length, 0);
  assert.equal(attempt.status, "denied");
  assert.match(attempt.reason, /allow-once policy decision/);
});

test("does not call sender for secret Discord payloads", async () => {
  const sender = fakeSender();
  const adapter = new ControlledDiscordAdapter({ sender, clock: fixedClock });
  const secretPlan = {
    ...allowedPlan(),
    sensitivity: "secret",
    redaction_state: "redacted"
  };

  const attempt = await adapter.send(
    approvedInput({
      delivery_plan: secretPlan,
      policy_decision: policyDecision({ subject_id: secretPlan.id })
    })
  );

  assert.equal(sender.calls.length, 0);
  assert.equal(attempt.status, "denied");
  assert.match(attempt.reason, /Secret Discord payloads cannot be sent/);
});

test("does not call sender for unconfigured Discord targets", async () => {
  const sender = fakeSender();
  const adapter = new ControlledDiscordAdapter({ sender, clock: fixedClock });

  const attempt = await adapter.send(
    approvedInput({
      configured_targets: [
        {
          guild_id: "guild-1",
          channel_id: "other-channel",
          thread_id: "thread-1"
        }
      ]
    })
  );

  assert.equal(sender.calls.length, 0);
  assert.equal(attempt.status, "denied");
  assert.match(attempt.reason, /not explicitly configured/);
});

test("does not call sender when pause or kill-switch guard is not accepted", async () => {
  const sender = fakeSender();
  const adapter = new ControlledDiscordAdapter({ sender, clock: fixedClock });

  const paused = await adapter.send(
    approvedInput({
      guards: { accepted: true, kill_switch_active: false, paused: true }
    })
  );
  const killSwitch = await adapter.send(
    approvedInput({
      guards: { accepted: true, kill_switch_active: true, paused: false }
    })
  );

  assert.equal(sender.calls.length, 0);
  assert.equal(paused.status, "denied");
  assert.equal(killSwitch.status, "denied");
  assert.match(paused.reason, /kill-switch and pause guards/);
  assert.match(killSwitch.reason, /kill-switch and pause guards/);
});

test("does not call sender when guard acceptance is false", async () => {
  const sender = fakeSender();
  const adapter = new ControlledDiscordAdapter({ sender, clock: fixedClock });

  const attempt = await adapter.send(
    approvedInput({
      guards: { accepted: false, kill_switch_active: false, paused: false }
    })
  );

  assert.equal(sender.calls.length, 0);
  assert.equal(attempt.status, "denied");
  assert.equal(attempt.sender_called, false);
  assert.equal(attempt.sender_call_count, 0);
  assert.match(attempt.reason, /kill-switch and pause guards/);
});

function fakeSender() {
  return {
    calls: [],
    async sendMessage(request) {
      this.calls.push(request);
      return { discord_message_id: "discord-message-1" };
    }
  };
}

function approvedInput(overrides = {}) {
  const plan = overrides.delivery_plan ?? allowedPlan();
  return {
    enable_real_send: true,
    delivery_plan: plan,
    policy_decision: policyDecision({ subject_id: plan.id }),
    configured_targets: [
      {
        guild_id: "guild-1",
        channel_id: "channel-1",
        thread_id: "thread-1"
      }
    ],
    guards: {
      accepted: true,
      kill_switch_active: false,
      paused: false
    },
    object_mutation_policy: {
      allow_message_create: true,
      allow_channel_or_thread_mutation: false
    },
    requested_object_mutations: ["message_create"],
    ...overrides
  };
}

function allowedPlan() {
  return planDiscordDelivery(
    {
      message_kind: "approval_request",
      workspace_id: "workspace.joseph",
      domain_id: "domain.nestdev",
      conversation_id: "conversation-1",
      target: {
        surface: "discord",
        guild_id: "guild-1",
        channel_id: "channel-1",
        thread_id: "thread-1",
        route_policy_id: "route.internal"
      },
      content: {
        title: "Approval needed",
        body: "Redacted send summary"
      },
      sensitivity: "internal",
      redaction_state: "redacted",
      idempotency_key: "idem-discord-real-send-1",
      dry_run: true,
      no_external_send: true
    },
    { clock: fixedClock }
  );
}

function policyDecision(overrides = {}) {
  return {
    schema: "openclaw.agent.policy_decision.v1",
    decision_id: "policy-decision-1",
    subject_kind: "discord_delivery",
    subject_id: "discord-delivery-plan-1",
    decision: "allow-once",
    risk_level: "low",
    reason: "Human-approved controlled Discord send.",
    no_external_side_effects: true,
    risk_flags: ["discord_delivery", "approved-real-send-boundary"],
    evaluated_at: "2026-05-10T18:05:00.000Z",
    metadata: {
      approved_for_controlled_discord_send: true
    },
    ...overrides
  };
}
