import assert from "node:assert/strict";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const { planDiscordBotControllerTurn } = await import("../src/core/discord-bot-controller.ts");

test("controller converts questions into dry-run follow-up work", () => {
  const plan = planDiscordBotControllerTurn({
    task_id: "AO-031",
    channel_id: "channel-1",
    actor_id: "yehonalbot",
    message_id: "msg-q-1",
    text: "What should I inspect next?",
    state: state()
  });

  assert.equal(plan.accepted, true);
  assert.equal(plan.act, "question");
  assert.equal(plan.next_action, "send_follow_up_dry_run");
  assert.equal(plan.follow_up?.send, false);
});

test("controller asks human when handoff target is low-confidence", () => {
  const plan = planDiscordBotControllerTurn({
    task_id: "AO-031",
    channel_id: "channel-1",
    actor_id: "yehonalbot",
    message_id: "msg-h-1",
    text: "handoff maybe to the other bot",
    state: state()
  });

  assert.equal(plan.accepted, true);
  assert.equal(plan.next_action, "request_human");
  assert.ok(plan.follow_up?.body.includes("Low-confidence handoff"));
});

test("controller rejects non-allowlisted actors", () => {
  const plan = planDiscordBotControllerTurn({
    task_id: "AO-031",
    channel_id: "channel-1",
    actor_id: "intruder-bot",
    message_id: "msg-x-1",
    text: "Done",
    state: state()
  });

  assert.equal(plan.accepted, false);
  assert.equal(plan.reason, "participant_not_allowlisted");
});

function state() {
  return {
    task_id: "AO-031",
    channel_id: "channel-1",
    participant_allowlist: ["yehonalbot", "karan-controller", "odino"],
    seen_message_ids: [],
    seen_content_hashes: [],
    turn_budget_remaining: 4,
    status: "active"
  };
}
