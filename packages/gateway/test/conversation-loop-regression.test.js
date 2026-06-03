import assert from "node:assert/strict";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const { planDiscordBotControllerTurn } = await import("../src/core/discord-bot-controller.ts");

test("controller suppresses duplicate content ping-pong from the same task", () => {
  const state = baseState({
    seen_content_hashes: ["hash-repeat"],
    seen_message_ids: ["msg-1"]
  });

  const plan = planDiscordBotControllerTurn({
    task_id: "AO-031",
    channel_id: "channel-1",
    actor_id: "yehonalbot",
    message_id: "msg-2",
    text: "same payload",
    message_hash: "hash-repeat",
    state
  });

  assert.equal(plan.accepted, false);
  assert.equal(plan.reason, "duplicate_content_hash");
  assert.equal(plan.next_action, "none");
});

test("controller pauses when turn budget is exhausted", () => {
  const plan = planDiscordBotControllerTurn({
    task_id: "AO-031",
    channel_id: "channel-1",
    actor_id: "yehonalbot",
    message_id: "msg-3",
    text: "progress update",
    state: baseState({ turn_budget_remaining: 0 })
  });

  assert.equal(plan.accepted, false);
  assert.equal(plan.reason, "turn_budget_exhausted");
  assert.equal(plan.next_action, "pause");
});

function baseState(overrides = {}) {
  return {
    task_id: "AO-031",
    channel_id: "channel-1",
    participant_allowlist: ["yehonalbot", "runtime-a-controller", "agent-alpha"],
    seen_message_ids: [],
    seen_content_hashes: [],
    turn_budget_remaining: 3,
    status: "active",
    ...overrides
  };
}
