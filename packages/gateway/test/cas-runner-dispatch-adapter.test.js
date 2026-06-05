import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const {
  StrictCasRunnerDispatchAdapter,
  createStrictDispatchInputFromPlan,
  evaluateDispatchGate
} = await import("../src/adapters/cas-runner-dispatch-adapter.ts");
const { createCasRunnerPlan } = await import("../src/core/cas-runner-planner.ts");
const { CasRunnerDispatchStore } = await import(
  "../src/core/cas-runner-dispatch-store.ts"
);
const { createPolicyDecisionRecord } = await import("../src/core/risk-classifier.ts");
const { validateCasRunnerDispatchRecord } = await import(
  "../src/schema/cas-runner-dispatch.ts"
);

const fixedClock = {
  now() {
    return new Date("2026-05-10T18:05:00.000Z");
  }
};

test("strict CAS dispatch adapter calls the injected dispatcher exactly once for approved input", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agent-mesh-cas-dispatch-"));
  const fake = fakeDispatcher();
  const adapter = new StrictCasRunnerDispatchAdapter(fake, { stateDir, clock: fixedClock });
  const input = approvedDispatchInput();

  const result = await adapter.dispatch(input);

  assert.equal(result.ok, true);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].execution_job_id, input.execution_job_id);
  assert.equal(result.result.dispatcher_called, true);
  assert.equal(result.result.dispatcher_result_id, "fake-dispatch-result-1");

  const records = await new CasRunnerDispatchStore({ stateDir }).list();
  assert.equal(records.length, 2);
  assert.equal(records[0].kind, "attempt");
  assert.equal(records[0].dispatcher_called, false);
  assert.equal(records[1].kind, "result");
  assert.equal(records[1].dispatcher_called, true);
  assert.equal(validateCasRunnerDispatchRecord(records[1]).ok, true);
});

test("strict CAS dispatch adapter never calls dispatcher unless every gate passes", async () => {
  const cases = [
    {
      name: "real dispatch flag disabled",
      patch: { enable_real_dispatch: false },
      reason: /enable_real_dispatch/
    },
    {
      name: "policy decision is not approved",
      patch: {
        policy_decision: policyDecision({
          subject_kind: "model_selection",
          subject_id: "model_selection_1",
          model_tier: "safety_review",
          cost_tier: "high"
        })
      },
      reason: /allow-once/
    },
    {
      name: "workspace is not scoped to repo",
      patch: { workspace_dir: "/path/to/runtime/workspace/other-package" },
      reason: /workspace_dir/
    },
    {
      name: "allowed actions include a prohibited operation",
      patch: { allowed_actions: ["read", "push"] },
      reason: /prohibited action/
    },
    {
      name: "forbidden actions omit deploy",
      patch: {
        forbidden_actions: approvedDispatchInput().forbidden_actions.filter(
          (action) => action !== "deploy"
        )
      },
      reason: /forbidden_actions/
    },
    {
      name: "write-capable job has read-only approval policy",
      patch: { approval_policy: "not_required_read_only" },
      reason: /ask_before_write/
    }
  ];

  for (const item of cases) {
    const stateDir = await mkdtemp(join(tmpdir(), "agent-mesh-cas-dispatch-blocked-"));
    const fake = fakeDispatcher();
    const adapter = new StrictCasRunnerDispatchAdapter(fake, { stateDir, clock: fixedClock });
    const input = { ...approvedDispatchInput(), ...item.patch };

    const result = await adapter.dispatch(input);

    assert.equal(result.ok, false, item.name);
    assert.equal(fake.calls.length, 0, item.name);
    assert.match(result.error.message, item.reason, item.name);

    const records = await new CasRunnerDispatchStore({ stateDir }).list();
    assert.equal(records.length, 1, item.name);
    assert.equal(records[0].kind, "attempt", item.name);
    assert.equal(records[0].status, "blocked", item.name);
    assert.equal(records[0].dispatcher_called, false, item.name);
  }
});

test("dispatch gate allows read-only jobs without write approval only when other controls pass", () => {
  const input = {
    ...approvedDispatchInput(),
    operation_mode: "analysis",
    approval_policy: "not_required_read_only",
    allowed_actions: ["read", "run_tests"]
  };

  assert.deepEqual(evaluateDispatchGate(input), {
    ok: true,
    reason: "Real CAS dispatch gates passed."
  });
});

function approvedDispatchInput(overrides = {}) {
  const plan = createCasRunnerPlan(
    {
      executionJob: executionJob(),
      thread_name: "agent-mesh/job-s",
      cas_roles: ["implementer", "reviewer_qa"],
      operation_mode: "code_edit",
      approval_policy: "ask_before_write",
      allowed_actions: ["read", "edit_package_files", "run_tests"],
      forbidden_actions: ["openclaw_core_edit"]
    },
    fixedClock
  );

  return {
    ...createStrictDispatchInputFromPlan(plan, {
      enable_real_dispatch: true,
      policy_decision: policyDecision({
        subject_kind: "cas_runner_plan",
        subject_id: plan.id
      })
    }),
    ...overrides
  };
}

function fakeDispatcher() {
  return {
    calls: [],
    async dispatch(payload) {
      this.calls.push(payload);
      return {
        dispatcher_result_id: "fake-dispatch-result-1",
        status: "dispatched",
        summary: "Fake dispatcher recorded one controlled dispatch.",
        metadata: { fake: true }
      };
    }
  };
}

function policyDecision(overrides = {}) {
  return createPolicyDecisionRecord(
    {
      subject_kind: "cas_runner_plan",
      subject_id: "cas_runner_plan_1",
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
    },
    { clock: fixedClock }
  );
}

function executionJob() {
  return {
    id: "execution_job_1",
    status: "stubbed",
    runner: "codex-stub",
    request: {
      requested_by_agent_id: "agent.software_engineer",
      workspace_id: "workspace.the operator",
      domain_id: "domain.nestdev",
      summary: "Dispatch through the strict CAS runner boundary.",
      policy_profile: "software_business_standard",
      endpoint_id: "default",
      workspace_dir: "/path/to/runtime/workspace/openclaw-agent-mesh-gateway",
      repo_scope: "openclaw-agent-mesh-gateway",
      approval_profile: "phase-2-local-stub",
      approval_required: false
    },
    governance: {
      decision: "record_only",
      policy_profile: "software_business_standard",
      approval_profile: "phase-2-local-stub",
      approval_status: "approved_stubbed",
      no_external_execution: true,
      reason: "CAS runner plan is locally approved.",
      evaluated_at: "2026-05-10T18:05:00.000Z",
      workspace_id: "workspace.the operator",
      domain_id: "domain.nestdev"
    },
    created_at: "2026-05-10T18:05:00.000Z",
    updated_at: "2026-05-10T18:05:00.000Z"
  };
}
