import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const {
  CasRunnerPlanFacade,
  REQUIRED_CAS_RUNNER_FORBIDDEN_ACTIONS,
  createCasRunnerPlan
} = await import("../src/core/cas-runner-planner.ts");
const { CasRunnerPlanStore } = await import("../src/core/cas-runner-plan-store.ts");

const fixedClock = {
  now() {
    return new Date("2026-05-10T17:20:00.000Z");
  }
};

test("CAS runner plan facade requires an explicitly scoped workspace", () => {
  assert.throws(
    () =>
      createCasRunnerPlan(
        planInput({
          executionJob: executionJob({
            request: {
              ...executionJob().request,
              workspace_dir: "/workspace/stub",
              repo_scope: "openclaw-agent-mesh-gateway"
            }
          })
        }),
        fixedClock
      ),
    /workspace_dir to be scoped to repo_scope/
  );

  assert.throws(
    () =>
      createCasRunnerPlan(
        planInput({
          executionJob: executionJob({
            request: {
              ...executionJob().request,
              workspace_dir: "relative/openclaw-agent-mesh-gateway"
            }
          })
        }),
        fixedClock
      ),
    /absolute workspace_dir/
  );
});

test("CAS runner plan facade enforces required forbidden actions", () => {
  const plan = createCasRunnerPlan(
    planInput({
      forbidden_actions: ["custom_forbidden_action"]
    }),
    fixedClock
  );

  for (const action of REQUIRED_CAS_RUNNER_FORBIDDEN_ACTIONS) {
    assert.equal(plan.forbidden_actions.includes(action), true, `missing ${action}`);
  }
  assert.equal(plan.forbidden_actions.includes("custom_forbidden_action"), true);
  assert.equal(plan.no_external_side_effects, true);
});

test("CAS runner plan facade requires approval policy for write-capable jobs", () => {
  assert.throws(
    () =>
      createCasRunnerPlan(
        planInput({
          operation_mode: "code_edit",
          allowed_actions: ["read", "edit_package_files"],
          approval_policy: "not_required_read_only"
        }),
        fixedClock
      ),
    /Write-capable CAS runner plans require/
  );

  const readOnlyPlan = createCasRunnerPlan(
    planInput({
      operation_mode: "analysis",
      allowed_actions: ["read"],
      approval_policy: "not_required_read_only"
    }),
    fixedClock
  );
  assert.equal(readOnlyPlan.approval_policy, "not_required_read_only");
});

test("CAS runner plan facade records no real adapter or codex_workers calls", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agent-mesh-cas-plan-"));
  const facade = new CasRunnerPlanFacade({ stateDir, clock: fixedClock });

  const plan = await facade.plan(planInput());

  assert.equal(plan.no_real_cas_adapter_call, true);
  assert.equal(plan.no_codex_workers_call, true);
  assert.equal(plan.no_external_side_effects, true);
  assert.equal(plan.metadata.source, "cas-runner-plan-facade");

  const stored = await new CasRunnerPlanStore({ stateDir, clock: fixedClock }).list();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, plan.id);
  assert.equal(stored[0].no_real_cas_adapter_call, true);
  assert.equal(stored[0].no_codex_workers_call, true);
});

test("CAS runner plan facade rejects non-approved or non-record-only execution jobs", () => {
  assert.throws(
    () =>
      createCasRunnerPlan(
        planInput({
          executionJob: executionJob({
            governance: {
              ...executionJob().governance,
              approval_status: "required_stubbed"
            }
          })
        }),
        fixedClock
      ),
    /approved_stubbed/
  );

  assert.throws(
    () =>
      createCasRunnerPlan(
        planInput({
          executionJob: executionJob({
            governance: {
              ...executionJob().governance,
              decision: "blocked_by_policy"
            }
          })
        }),
        fixedClock
      ),
    /record_only/
  );
});

function planInput(overrides = {}) {
  return {
    executionJob: executionJob(),
    thread_name: "agent-mesh/job-o",
    cas_roles: ["implementer", "reviewer_qa"],
    operation_mode: "code_edit",
    approval_policy: "ask_before_write",
    allowed_actions: ["read", "edit_package_files", "run_tests"],
    forbidden_actions: ["openclaw_core_edit"],
    ...overrides
  };
}

function executionJob(overrides = {}) {
  const base = {
    id: "execution_job_1",
    status: "stubbed",
    runner: "codex-stub",
    request: {
      requested_by_agent_id: "agent.software_engineer",
      workspace_id: "workspace.joseph",
      domain_id: "domain.nestdev",
      summary: "Record a local CAS runner plan.",
      policy_profile: "software_business_standard",
      endpoint_id: "default",
      workspace_dir: "/root/.openclaw/workspace/openclaw-agent-mesh-gateway",
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
      reason: "CAS runner is stub-only.",
      evaluated_at: "2026-05-10T17:20:00.000Z",
      workspace_id: "workspace.joseph",
      domain_id: "domain.nestdev"
    },
    created_at: "2026-05-10T17:20:00.000Z",
    updated_at: "2026-05-10T17:20:00.000Z"
  };

  return {
    ...base,
    ...overrides,
    request: {
      ...base.request,
      ...(overrides.request ?? {})
    },
    governance: {
      ...base.governance,
      ...(overrides.governance ?? {})
    }
  };
}
