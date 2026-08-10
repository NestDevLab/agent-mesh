import assert from "node:assert/strict";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const { buildAgentOsE2eDemo } = await import("../src/demo/demo-agent-os-e2e.ts");
const { validateHumanRequestRecord, validateHumanDecisionRecord } = await import("../src/schema/human-request.ts");
const { validateProactivityFindingRecord } = await import("../src/schema/proactivity-task-thread-flow.ts");
const { validateConversationActRecord } = await import("../src/schema/conversation-act.ts");

test("Agent OS E2E demo is deterministic and dry-run safe", () => {
  assert.deepEqual(buildAgentOsE2eDemo(), buildAgentOsE2eDemo());
});

test("Agent OS E2E demo links the full dry-run lifecycle", () => {
  const demo = buildAgentOsE2eDemo();

  assert.equal(demo.demo, "agent-os-e2e-dry-run");
  assert.equal(demo.generated_at, "2026-05-13T17:35:00.000Z");
  assert.deepEqual(demo.side_effects, []);
  assert.deepEqual(demo.guardrails, {
    dry_run: true,
    no_real_discord_send: true,
    no_real_runner_dispatch: true,
    no_restart: true,
    no_new_channel_creation: true
  });

  assert.equal(validateProactivityFindingRecord(demo.flow.finding).ok, true);
  assert.equal(validateHumanRequestRecord(demo.flow.human_request).ok, true);
  assert.equal(validateHumanDecisionRecord(demo.flow.human_decision.decision).ok, true);
  assert.equal(validateConversationActRecord(demo.flow.worker_turn.act_record).ok, true);

  assert.equal(demo.flow.task_thread_flow.notify_in_discord, true);
  assert.equal(demo.flow.human_request.status, "drafted");
  assert.equal(demo.flow.human_decision.request.status, "approved");
  assert.equal(demo.flow.worker_turn.reduction.next_action, "verify_completion");
  assert.equal(demo.flow.controller_turn.next_action, "verify_completion");
});
