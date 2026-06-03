import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const { createPolicyDecisionRecord } = await import("../src/core/risk-classifier.ts");
const { PolicyDecisionStore } = await import("../src/core/policy-decision-store.ts");
const { validatePolicyDecisionRecord } = await import(
  "../src/schema/policy-decision.ts"
);

const fixedClock = {
  now() {
    return new Date("2026-05-10T17:40:00.000Z");
  }
};

test("validates unified policy decision records and enforces no external side effects", () => {
  const decision = createPolicyDecisionRecord(baseInput(), { clock: fixedClock });

  assert.equal(validatePolicyDecisionRecord(decision).ok, true);
  assert.equal(decision.schema, "openclaw.agent.policy_decision.v1");
  assert.equal(decision.no_external_side_effects, true);

  const invalid = validatePolicyDecisionRecord({
    ...decision,
    no_external_side_effects: false
  });
  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.issues.map((issue) => issue.path), ["no_external_side_effects"]);
});

test("maps execution_job and cas_runner_plan stub records to allow-once low risk", () => {
  const executionJob = createPolicyDecisionRecord(baseInput(), { clock: fixedClock });
  const casRunnerPlan = createPolicyDecisionRecord(
    baseInput({
      subject_kind: "cas_runner_plan",
      subject_id: "cas_runner_plan_1",
      tool_capability: "read",
      metadata: { source_schema: "openclaw.agent.cas_runner_plan.v1" }
    }),
    { clock: fixedClock }
  );

  assert.equal(executionJob.decision, "allow-once");
  assert.equal(executionJob.risk_level, "low");
  assert.equal(casRunnerPlan.decision, "allow-once");
  assert.equal(casRunnerPlan.risk_level, "low");
  assert.ok(casRunnerPlan.risk_flags.includes("cas_runner_plan"));
});

test("maps memory actions to ask-human or deny based on durable write and secret risk", () => {
  const durableMemory = createPolicyDecisionRecord(
    baseInput({
      subject_kind: "memory_action",
      subject_id: "memory_action_1",
      target: "memory_wiki",
      sensitivity: "internal",
      operation_reversibility: "partially_reversible"
    }),
    { clock: fixedClock }
  );
  const unredactedSecret = createPolicyDecisionRecord(
    baseInput({
      subject_kind: "memory_action",
      subject_id: "memory_action_secret",
      target: "mem0_scope",
      sensitivity: "secret",
      redaction_state: "none"
    }),
    { clock: fixedClock }
  );

  assert.equal(durableMemory.decision, "ask-human");
  assert.equal(durableMemory.risk_level, "medium");
  assert.ok(durableMemory.risk_flags.includes("durable-memory-target"));
  assert.equal(unredactedSecret.decision, "deny");
  assert.equal(unredactedSecret.risk_level, "critical");
  assert.ok(unredactedSecret.risk_flags.includes("secret-unredacted"));
});

test("maps Discord delivery to ask-human and external sends to deny", () => {
  const discordDryRun = createPolicyDecisionRecord(
    baseInput({
      subject_kind: "discord_delivery",
      subject_id: "discord_delivery_1",
      destination: "discord",
      sensitivity: "internal",
      tool_capability: "plan_message"
    }),
    { clock: fixedClock }
  );
  const realSendAttempt = createPolicyDecisionRecord(
    baseInput({
      subject_kind: "discord_delivery",
      subject_id: "discord_delivery_send",
      destination: "discord",
      tool_capability: "send_message",
      external_side_effects: true
    }),
    { clock: fixedClock }
  );

  assert.equal(discordDryRun.decision, "ask-human");
  assert.equal(discordDryRun.risk_level, "medium");
  assert.equal(realSendAttempt.decision, "deny");
  assert.equal(realSendAttempt.risk_level, "critical");
  assert.ok(realSendAttempt.risk_flags.includes("external-side-effects-requested"));
});

test("maps proactivity and model selection subjects through shared risk levels", () => {
  const proactivity = createPolicyDecisionRecord(
    baseInput({
      subject_kind: "proactivity_action",
      subject_id: "proactivity_1",
      tool_capability: "triage",
      explicitly_requested: false
    }),
    { clock: fixedClock }
  );
  const modelSelection = createPolicyDecisionRecord(
    baseInput({
      subject_kind: "model_selection",
      subject_id: "model_selection_1",
      model_tier: "safety_review",
      cost_tier: "high"
    }),
    { clock: fixedClock }
  );

  assert.equal(proactivity.decision, "ask-human");
  assert.equal(proactivity.risk_level, "medium");
  assert.ok(proactivity.risk_flags.includes("not-explicitly-requested"));
  assert.equal(modelSelection.decision, "ask-human");
  assert.equal(modelSelection.risk_level, "high");
  assert.ok(modelSelection.risk_flags.includes("high-cost-or-model-tier"));
});

test("records unified policy decisions in the local NDJSON store", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agent-mesh-policy-decision-"));
  const store = new PolicyDecisionStore({ stateDir, clock: fixedClock });
  const decision = createPolicyDecisionRecord(baseInput(), { clock: fixedClock });

  await store.append(decision);
  const records = await store.list();

  assert.equal(records.length, 1);
  assert.equal(records[0].decision_id, decision.decision_id);
  assert.equal(records[0].schema, "openclaw.agent.policy_decision.v1");
  assert.equal(records[0].no_external_side_effects, true);
});

function baseInput(overrides = {}) {
  return {
    subject_kind: "execution_job",
    subject_id: "execution_job_1",
    sensitivity: "internal",
    external_side_effects: false,
    no_external_side_effects: true,
    target: "local_package_files",
    destination: "local",
    cost_tier: "low",
    model_tier: "routine_fast",
    tool_capability: "read",
    domain_id: "domain.nestdev",
    project_id: "project.agent_mesh",
    operation_reversibility: "reversible",
    explicitly_requested: true,
    redaction_state: "redacted",
    ...overrides
  };
}
