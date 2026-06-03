import assert from "node:assert/strict";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const { planConversationTurn, classifyConversationAct } = await import("../src/core/conversation-orchestrator.ts");
const { initialConversationTaskState } = await import("../src/core/conversation-reducer.ts");

const fixedClock = { now: () => new Date("2026-05-13T16:00:00.000Z") };

test("classifies completion claims and requires verification before close", () => {
  const plan = planConversationTurn(
    {
      task_id: "AO-030",
      actor_id: "yehonalbot",
      message_id: "msg-complete-1",
      text: "Done, completed the assigned scope.",
      state: initialConversationTaskState("AO-030")
    },
    { clock: fixedClock }
  );

  assert.equal(plan.act_record.act, "complete");
  assert.equal(plan.reduction.next_action, "verify_completion");
  assert.equal(plan.reduction.state.status, "completed");
  assert.equal(plan.reply_plan?.send, false);
});

test("classifies handoff and extracts next actor when present", () => {
  const turn = classifyConversationAct("Please handoff to odino for the next step");
  assert.equal(turn.act, "handoff");
  assert.equal(turn.target_agent_id, "odino");
});

test("blocked messages create a human-request path and stop prompting", () => {
  const plan = planConversationTurn(
    {
      task_id: "AO-030",
      actor_id: "karan-nestdev",
      message_id: "msg-blocked-1",
      text: "Blocked: missing access to the delivery surface.",
      state: initialConversationTaskState("AO-030")
    },
    { clock: fixedClock }
  );

  assert.equal(plan.act_record.act, "blocked");
  assert.equal(plan.reduction.stop, true);
  assert.equal(plan.reduction.next_action, "create_human_request");
});
