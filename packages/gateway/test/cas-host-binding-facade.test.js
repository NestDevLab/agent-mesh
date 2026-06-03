import assert from "node:assert/strict";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const {
  CAS_HOST_PROMPT_GUARDRAILS,
  CasHostBindingFacade,
  createHostCasInvocationRequest
} = await import("../src/adapters/cas-host-binding-facade.ts");
const { StrictCasRunnerDispatchAdapter } = await import(
  "../src/adapters/cas-runner-dispatch-adapter.ts"
);
const { createPolicyDecisionRecord } = await import("../src/core/risk-classifier.ts");

test("CAS host binding facade calls the host invoker exactly once for a /tmp workspace", async () => {
  const calls = [];
  const facade = new CasHostBindingFacade(async (request) => {
    calls.push(request);
    return {
      invocationId: "host-cas-invocation-1",
      summary: "Host CAS invocation accepted.",
      metadata: { fake_host: true }
    };
  });

  const result = await facade.dispatch(payload());

  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpointId, "default");
  assert.equal(calls[0].workspaceDir, "/tmp/openclaw-agent-mesh-cas-host-smoke");
  assert.equal(calls[0].threadName, "agent-mesh/job-v-host-binding");
  assert.equal(calls[0].safety.smokeMode, true);
  assert.equal(calls[0].safety.tempWorkspaceRequired, true);
  assert.equal(result.dispatcher_result_id, "host-cas-invocation-1");
  assert.equal(result.status, "dispatched");
  assert.equal(result.metadata.fake_host, true);
});

test("CAS host binding facade rejects non-/tmp workspaces by default", async () => {
  let callCount = 0;
  const facade = new CasHostBindingFacade(async () => {
    callCount += 1;
    return { invocationId: "should-not-run", summary: "should not run" };
  });

  await assert.rejects(
    facade.dispatch(payload({ workspace_dir: "/root/.openclaw/workspace/openclaw-agent-mesh-gateway" })),
    /requires workspaceDir under \/tmp/
  );
  assert.equal(callCount, 0);
});

test("CAS host binding prompt includes exact required guardrails", () => {
  const request = createHostCasInvocationRequest(payload());

  for (const guardrail of CAS_HOST_PROMPT_GUARDRAILS) {
    assert.match(request.prompt, new RegExp(`- ${escapeRegExp(guardrail)}`));
  }
  assert.match(request.prompt, /Workspace: \/tmp\/openclaw-agent-mesh-cas-host-smoke/);
  assert.equal(request.safety.workspaceOnly, true);
  assert.equal(request.safety.noPushPublishDeployRestartDelete, true);
  assert.equal(request.safety.noSecrets, true);
  assert.equal(request.safety.reportFilesAndTestOutput, true);
  assert.equal(request.safety.noDirectOpenClawTools, true);
  assert.equal(request.safety.noCodexWorkersRunTask, true);
});

test("CAS host binding facade maps host failure to dispatcher error", async () => {
  const facade = new CasHostBindingFacade(async () => {
    throw new Error("host CAS unavailable");
  });

  await assert.rejects(facade.dispatch(payload()), /host CAS unavailable/);
});

test("strict CAS dispatch maps host binding failure to a failed result record", async () => {
  const hostFacade = new CasHostBindingFacade(async () => {
    throw new Error("host CAS unavailable");
  });
  const adapter = new StrictCasRunnerDispatchAdapter(hostFacade, { clock: fixedClock });

  const result = await adapter.dispatch({
    ...payload(),
    enable_real_dispatch: true,
    policy_decision: policyDecision()
  });

  assert.equal(result.ok, false);
  assert.equal(result.result.status, "failed");
  assert.equal(result.result.dispatcher_called, true);
  assert.match(result.error.message, /host CAS unavailable/);
});

const fixedClock = {
  now() {
    return new Date("2026-05-10T18:29:00.000Z");
  }
};

function payload(overrides = {}) {
  return {
    execution_job_id: "execution_job_v",
    plan_id: "cas_runner_plan_v",
    endpoint_id: "default",
    workspace_dir: "/tmp/openclaw-agent-mesh-cas-host-smoke",
    repo_scope: "openclaw-agent-mesh-cas-host-smoke",
    thread_name: "agent-mesh/job-v-host-binding",
    cas_roles: ["implementer"],
    operation_mode: "code_edit",
    approval_policy: "ask_before_write",
    allowed_actions: ["read", "edit_package_files", "run_tests"],
    forbidden_actions: [
      "push",
      "publish",
      "deploy",
      "restart",
      "delete",
      "openclaw_core_edit",
      "external_message",
      "real_cas_adapter_call",
      "codex_workers_run_task"
    ],
    metadata: {
      summary: "Add the safe CAS host binding smoke facade."
    },
    ...overrides
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function policyDecision() {
  return createPolicyDecisionRecord(
    {
      subject_kind: "cas_runner_plan",
      subject_id: "cas_runner_plan_v",
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
      redaction_state: "redacted"
    },
    { clock: fixedClock }
  );
}
