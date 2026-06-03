import assert from "node:assert/strict";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const { buildPhase2PolicyCompletionDemo, buildPhase2PolicyDemo } = await import(
  "../src/demo/demo-phase2-policy.ts"
);
const { validateCasRunnerDispatchRecord } = await import(
  "../src/schema/cas-runner-dispatch.ts"
);
const { validateCasRunnerPlanRecord } = await import("../src/schema/cas-runner-plan.ts");
const { validateDiscordDeliveryPlan } = await import(
  "../src/schema/discord-delivery-plan.ts"
);
const { validateDiscordSendAttemptRecord } = await import(
  "../src/schema/discord-send-attempt.ts"
);
const { validateMemoryFabricPolicyDecision } = await import(
  "../src/schema/memory-fabric.ts"
);
const { validateModelSelectionRecord } = await import(
  "../src/schema/model-selection.ts"
);
const { validatePolicyDecisionRecord } = await import(
  "../src/schema/policy-decision.ts"
);
const { validateProactivityRecord } = await import("../src/schema/proactivity.ts");

test("Phase 2 policy demo returns deterministic stub-safe inspection JSON", () => {
  const demo = buildPhase2PolicyDemo();

  assert.equal(demo.demo, "phase2-policy-inspection");
  assert.equal(demo.generated_at, "2026-05-10T12:30:00.000Z");
  assert.deepEqual(demo.guardrails, {
    no_external_execution: true,
    no_external_write: true,
    no_runtime_config_change: true,
    real_adapters_called: false
  });

  assert.equal(validateMemoryFabricPolicyDecision(demo.memory_proposal_decision).ok, true);
  assert.equal(validateProactivityRecord(demo.stale_backlog_proactivity_proposal).ok, true);
  assert.equal(
    validateModelSelectionRecord(demo.model_selection_for_code_implementation).ok,
    true
  );

  assert.equal(demo.memory_proposal_decision.decision, "allow-once");
  assert.equal(demo.memory_proposal_decision.no_external_write, true);
  assert.equal(
    demo.stale_backlog_proactivity_proposal.proposed_action_kind,
    "triage"
  );
  assert.equal(demo.stale_backlog_proactivity_proposal.backlog_outcome, "decide");
  assert.equal(demo.stale_backlog_proactivity_proposal.no_external_execution, true);
  assert.equal(
    demo.model_selection_for_code_implementation.selected_profile,
    "specialist_coding"
  );
  assert.equal(
    demo.model_selection_for_code_implementation.no_runtime_config_change,
    true
  );
  assert.equal(demo.cas_team_sizing.orchestration, "two_roles");
  assert.deepEqual(demo.cas_team_sizing.roles, ["implementer", "reviewer_qa"]);
  assert.equal(demo.cas_team_sizing.approval_required, false);
});

test("Phase 2 policy demo is stable across repeated calls", () => {
  assert.deepEqual(buildPhase2PolicyDemo(), buildPhase2PolicyDemo());
});

test("Phase 2 policy completion demo returns unified policy records for all planners", async () => {
  const demo = await buildPhase2PolicyCompletionDemo();

  assert.equal(demo.demo, "phase2-policy-completion");
  assert.equal(demo.generated_at, "2026-05-10T12:30:00.000Z");
  assert.equal(validateCasRunnerPlanRecord(demo.cas_runner_plan).ok, true);
  assert.equal(validateCasRunnerDispatchRecord(demo.cas_dispatch_attempt).ok, true);
  assert.equal(validateCasRunnerDispatchRecord(demo.cas_dispatch_result).ok, true);
  assert.equal(validateDiscordDeliveryPlan(demo.discord_delivery_plan).ok, true);
  assert.equal(validateDiscordSendAttemptRecord(demo.discord_send_attempt).ok, true);

  for (const decision of Object.values(demo.unified_policy_decisions)) {
    assert.equal(validatePolicyDecisionRecord(decision).ok, true);
    assert.equal(decision.no_external_side_effects, true);
  }

  assert.deepEqual(Object.keys(demo.unified_policy_decisions), [
    "memory",
    "proactivity",
    "model_selection",
    "cas_plan",
    "cas_dispatch",
    "discord_plan",
    "discord_send"
  ]);
  assert.equal(demo.unified_policy_decisions.memory.subject_kind, "memory_action");
  assert.equal(demo.unified_policy_decisions.proactivity.subject_kind, "proactivity_action");
  assert.equal(demo.unified_policy_decisions.model_selection.subject_kind, "model_selection");
  assert.equal(demo.unified_policy_decisions.cas_plan.subject_id, demo.cas_runner_plan.id);
  assert.equal(demo.unified_policy_decisions.cas_dispatch.subject_id, demo.cas_runner_plan.id);
  assert.equal(demo.unified_policy_decisions.discord_plan.subject_id, demo.discord_delivery_plan.id);
  assert.equal(demo.unified_policy_decisions.discord_send.subject_id, demo.discord_delivery_plan.id);

  assert.equal(demo.cas_dispatch_attempt.dispatcher_called, false);
  assert.equal(demo.cas_dispatch_result.dispatcher_called, true);
  assert.equal(demo.discord_send_attempt.sender_called, true);
  assert.equal(demo.discord_send_attempt.openclaw_message_tool_called, false);
  assert.deepEqual(demo.injected_adapters, {
    fake_dispatcher_called: true,
    fake_dispatcher_call_count: 1,
    fake_sender_called: true,
    fake_sender_call_count: 1,
    direct_openclaw_message_tool_called: false,
    direct_codex_workers_called: false
  });
  assert.equal(demo.guardrails.real_adapters_called, false);
});

test("Phase 2 policy completion demo is stable across repeated calls", async () => {
  assert.deepEqual(
    await buildPhase2PolicyCompletionDemo(),
    await buildPhase2PolicyCompletionDemo()
  );
});
