import assert from "node:assert/strict";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const { recommendCasTeamSize, selectModelProfile } = await import(
  "../src/core/model-selection.js"
);
const { validateModelSelectionRecord } = await import(
  "../src/schema/model-selection.js"
);

test("routes software code implementation to specialist coding", () => {
  const selection = selectModelProfile(baseInput());

  assert.equal(selection.selected_profile, "specialist_coding");
  assert.equal(selection.selected_model_alias, "codex-default");
  assert.equal(selection.reasoning_effort, "medium");
  assert.equal(selection.no_runtime_config_change, true);
  assert.equal(validateModelSelectionRecord(selection).ok, true);
});

test("routes security and high-risk work to safety review", () => {
  const securitySelection = selectModelProfile({
    ...baseInput(),
    agent_id: "agent.security",
    agent_role: "security",
    task_kind: "security_review",
    risk: "medium"
  });
  assert.equal(securitySelection.selected_profile, "safety_review");

  const highRiskSelection = selectModelProfile({
    ...baseInput(),
    task_kind: "research",
    complexity: "medium",
    risk: "high"
  });
  assert.equal(highRiskSelection.selected_profile, "safety_review");
});

test("routes low-risk routine work to routine fast", () => {
  const selection = selectModelProfile({
    ...baseInput(),
    agent_id: "agent.chief_of_staff",
    agent_role: "orchestration",
    task_kind: "triage",
    complexity: "low",
    risk: "low",
    sensitivity: "internal",
    external_side_effects_possible: false
  });

  assert.equal(selection.selected_profile, "routine_fast");
  assert.equal(selection.approval_required, false);
});

test("routes private and secret context to local private when available", () => {
  const privateSelection = selectModelProfile({
    ...baseInput(),
    task_kind: "summary",
    sensitivity: "private",
    complexity: "low",
    risk: "low"
  });
  assert.equal(privateSelection.selected_profile, "local_private");

  const secretSelection = selectModelProfile({
    ...baseInput(),
    task_kind: "memory",
    sensitivity: "secret",
    complexity: "medium",
    risk: "medium"
  });
  assert.equal(secretSelection.selected_profile, "local_private");
});

test("requires approval when private context cannot use local private", () => {
  const selection = selectModelProfile({
    ...baseInput(),
    task_kind: "research",
    sensitivity: "secret",
    local_private_available: false
  });

  assert.equal(selection.selected_profile, "deep_reasoning");
  assert.equal(selection.approval_required, true);
});

test("sizes medium code implementation as two CAS roles", () => {
  const recommendation = recommendCasTeamSize({
    task_kind: "code_implementation",
    complexity: "medium",
    risk: "medium"
  });

  assert.equal(recommendation.orchestration, "two_roles");
  assert.deepEqual(recommendation.roles, ["implementer", "reviewer_qa"]);
  assert.equal(recommendation.approval_required, false);
});

function baseInput() {
  return {
    agent_id: "agent.software_engineer",
    agent_role: "software_engineering",
    workspace_id: "workspace.joseph",
    domain_id: "domain.nestdev",
    project_id: "project.agent_mesh",
    task_id: "task-model-selection",
    task_kind: "code_implementation",
    complexity: "medium",
    risk: "medium",
    sensitivity: "internal",
    external_side_effects_possible: false,
    created_at: "2026-05-10T07:00:00.000Z"
  };
}
