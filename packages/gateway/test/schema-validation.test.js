import assert from "node:assert/strict";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const {
  AGENT_MESSAGE_SCHEMA,
  validateAgentMessageEnvelopeV1
} = await import("../src/schema/envelope.js");
const { validateDeliveryRecord } = await import("../src/schema/delivery.js");
const { validateDiscordDeliveryPlan } = await import("../src/schema/discord-delivery-plan.js");
const { validateHeartbeatRecord } = await import("../src/schema/heartbeat.js");
const { validateExecutionJob } = await import("../src/schema/execution-job.js");
const { validateApprovalGateEvaluation } = await import("../src/schema/approval.js");
const { validateCasRunnerPlanRecord } = await import("../src/schema/cas-runner-plan.ts");
const { validateCasRunnerDispatchRecord } = await import(
  "../src/schema/cas-runner-dispatch.ts"
);
const { validateMeshContextRecord } = await import("../src/schema/context.js");
const { validateMeshAgentRecord } = await import("../src/schema/agent.js");
const { validateAuditEvent } = await import("../src/schema/audit.js");

test("validates the Phase 1 agent message envelope", () => {
  const result = validateAgentMessageEnvelopeV1({
    schema: AGENT_MESSAGE_SCHEMA,
    schema_version: "1",
    message_id: "msg-1",
    workspace_id: "workspace.joseph",
    domain_id: "domain.nestdev",
    conversation_id: "conversation-1",
    from: "agent.chief_of_staff",
    to: "agent.software_engineer",
    intent: "request",
    ttl: 3,
    hop_count: 0,
    idempotency_key: "idem-1",
    content: { text: "Inspect the failing test." },
    created_at: "2026-05-09T12:00:00.000Z",
    trace_id: null,
    sensitivity: "internal",
    redaction_state: "none",
    labels: ["phase-1"],
    metadata: { source: "test" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.trace_id, null);
  assert.equal(result.value.content.text, "Inspect the failing test.");
});

test("rejects invalid envelope ttl, hop count, enum, and content shape", () => {
  const result = validateAgentMessageEnvelopeV1({
    schema: AGENT_MESSAGE_SCHEMA,
    message_id: "msg-1",
    workspace_id: "workspace.joseph",
    domain_id: "domain.nestdev",
    conversation_id: "conversation-1",
    from: "agent.chief_of_staff",
    to: "agent.software_engineer",
    intent: "bad-intent",
    ttl: 0,
    hop_count: -1,
    idempotency_key: "idem-1",
    content: ["not", "object"],
    created_at: "2026-05-09T12:00:00.000Z"
  });

  assert.equal(result.ok, false);
  assert.match(result.issues.map((issue) => issue.path).join(","), /intent/);
  assert.match(result.issues.map((issue) => issue.path).join(","), /ttl/);
  assert.match(result.issues.map((issue) => issue.path).join(","), /hop_count/);
  assert.match(result.issues.map((issue) => issue.path).join(","), /content/);
});

test("validates delivery status enum", () => {
  const result = validateDeliveryRecord({
    id: "delivery-1",
    message_id: "msg-1",
    adapter_id: "simulated-agent",
    target_agent_id: "agent.software_engineer",
    status: "teleported",
    attempts: 0,
    max_attempts: 3,
    created_at: "2026-05-09T12:00:00.000Z",
    updated_at: "2026-05-09T12:00:00.000Z"
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map((issue) => issue.path), ["status"]);
});

test("requires Discord delivery plans to remain dry-run and no_external_send", () => {
  const result = validateDiscordDeliveryPlan({
    id: "discord_delivery_plan-1",
    message_kind: "approval_request",
    workspace_id: "workspace.joseph",
    domain_id: "domain.nestdev",
    conversation_id: "conversation-1",
    target: {
      surface: "discord",
      channel_id: "channel-1",
      thread_id: "thread-1"
    },
    content: {
      title: "Approval needed",
      body: "Safe dry-run preview"
    },
    sensitivity: "internal",
    redaction_state: "redacted",
    visibility: "internal",
    idempotency_key: "idem-discord-1",
    decision: "allow-dry-run",
    status: "planned_stubbed",
    reason: "Dry-run Discord delivery plan recorded without external send.",
    risk_flags: ["stub-only"],
    dry_run: true,
    no_external_send: false,
    adapter_flags: {
      discord_adapter_called: false,
      openclaw_message_tool_called: false,
      discord_objects_mutated: false
    },
    created_at: "2026-05-10T17:20:00.000Z"
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map((issue) => issue.path), ["no_external_send"]);
});

test("validates heartbeat and execution job records", () => {
  assert.equal(
    validateHeartbeatRecord({
      id: "heartbeat-1",
      agent_id: "agent.software_engineer",
      status: "simulated",
      observed_at: "2026-05-09T12:00:00.000Z",
      details: { host: "stub" }
    }).ok,
    true
  );

  assert.equal(
    validateExecutionJob({
      id: "job-1",
      status: "stubbed",
      runner: "codex-stub",
      request: {
        requested_by_agent_id: "agent.chief_of_staff",
        workspace_id: "workspace.joseph",
        domain_id: "domain.nestdev",
        project_id: "project.agent_mesh",
        task_id: null,
        conversation_id: "conversation-1",
        correlation_id: "corr-1",
        source_message_id: "msg-1",
        control_intent: "run",
        summary: "Run a stub job.",
        policy_profile: "software_business_standard",
        endpoint_id: "cas-stub-local",
        workspace_dir: "/workspace/stub",
        repo_scope: "openclaw-agent-mesh-gateway",
        approval_profile: "stub-no-external-actions",
        approval_required: true,
        metadata: { source: "schema-test" }
      },
      governance: {
        decision: "record_only",
        policy_profile: "software_business_standard",
        approval_profile: "stub-no-external-actions",
        approval_status: "required_stubbed",
        no_external_execution: true,
        reason: "CAS runner is stub-only.",
        evaluated_at: "2026-05-09T12:00:00.000Z",
        workspace_id: "workspace.joseph",
        domain_id: "domain.nestdev",
        project_id: "project.agent_mesh",
        task_id: null,
        conversation_id: "conversation-1",
        correlation_id: "corr-1",
        source_message_id: "msg-1",
        metadata: { source: "schema-test" }
      },
      created_at: "2026-05-09T12:00:00.000Z",
      updated_at: "2026-05-09T12:00:00.000Z"
    }).ok,
    true
  );
});

test("validates local Guardian approval gate evaluations", () => {
  const result = validateApprovalGateEvaluation({
    request: {
      id: "approval_request-1",
      subject_kind: "execution_job",
      subject_id: "job-1",
      action: "run",
      requested_by_agent_id: "agent.software_engineer",
      workspace_id: "workspace.joseph",
      domain_id: "domain.nestdev",
      policy_profile: "software_business_standard",
      reviewer_flow: "local-stub-human-review-required",
      approval_profile: "phase-2-local-stub",
      risk_flags: ["execution_job", "approval-required"],
      requested_at: "2026-05-09T12:00:00.000Z",
      no_external_execution: true
    },
    decision: {
      id: "approval_decision-1",
      request_id: "approval_request-1",
      decision: "ask-human",
      status: "requires_human_stubbed",
      reason: "Local stub requires human approval.",
      policy_profile: "software_business_standard",
      reviewer_flow: "local-stub-human-review-required",
      evaluated_at: "2026-05-09T12:00:00.000Z",
      no_external_execution: true,
      human_escalation_required: true
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.decision.decision, "ask-human");
});

test("validates CAS runner plan records as stub-only", () => {
  const result = validateCasRunnerPlanRecord({
    schema: "openclaw.agent.cas_runner_plan.v1",
    id: "cas_runner_plan-1",
    execution_job_id: "execution_job-1",
    status: "planned_stub_only",
    endpoint_id: "default",
    workspace_dir: "/root/.openclaw/workspace/openclaw-agent-mesh-gateway",
    repo_scope: "openclaw-agent-mesh-gateway",
    thread_name: "agent-mesh/job-o",
    cas_roles: ["implementer", "reviewer_qa"],
    operation_mode: "code_edit",
    approval_policy: "ask_before_write",
    allowed_actions: ["read", "edit_package_files", "run_tests"],
    forbidden_actions: ["openclaw_core_edit", "push", "publish", "deploy", "restart"],
    no_external_side_effects: true,
    no_real_cas_adapter_call: true,
    no_codex_workers_call: true,
    created_at: "2026-05-10T17:20:00.000Z",
    reason: "Stub-only plan."
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.no_external_side_effects, true);

  const invalid = validateCasRunnerPlanRecord({
    schema: "openclaw.agent.cas_runner_plan.v1",
    id: "cas_runner_plan-1",
    execution_job_id: "execution_job-1",
    status: "planned_stub_only",
    endpoint_id: "default",
    workspace_dir: "/root/.openclaw/workspace/openclaw-agent-mesh-gateway",
    repo_scope: "openclaw-agent-mesh-gateway",
    thread_name: "agent-mesh/job-o",
    cas_roles: ["implementer"],
    operation_mode: "code_edit",
    approval_policy: "ask_before_write",
    allowed_actions: ["read"],
    forbidden_actions: ["push"],
    no_external_side_effects: true,
    no_real_cas_adapter_call: false,
    no_codex_workers_call: true,
    created_at: "2026-05-10T17:20:00.000Z",
    reason: "Stub-only plan."
  });

  assert.equal(invalid.ok, false);
  assert.match(invalid.issues.map((issue) => issue.path).join(","), /no_real_cas_adapter_call/);
});

test("validates CAS runner dispatch attempt and result records", () => {
  const result = validateCasRunnerDispatchRecord({
    schema: "openclaw.agent.cas_runner_dispatch_record.v1",
    id: "cas_runner_dispatch-1",
    kind: "result",
    execution_job_id: "execution_job-1",
    plan_id: "cas_runner_plan-1",
    status: "dispatched",
    enable_real_dispatch: true,
    endpoint_id: "default",
    workspace_dir: "/root/.openclaw/workspace/openclaw-agent-mesh-gateway",
    repo_scope: "openclaw-agent-mesh-gateway",
    policy_decision_id: "policy_decision-1",
    policy_decision: "allow-once",
    approval_policy: "ask_before_write",
    allowed_actions: ["read", "edit_package_files", "run_tests"],
    forbidden_actions: ["openclaw_core_edit", "push", "publish", "deploy", "restart"],
    dispatcher_called: true,
    created_at: "2026-05-10T18:05:00.000Z",
    reason: "Fake dispatcher recorded one controlled dispatch.",
    dispatcher_result_id: "fake-dispatch-result-1"
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.dispatcher_called, true);

  const invalid = validateCasRunnerDispatchRecord({
    schema: "openclaw.agent.cas_runner_dispatch_record.v1",
    id: "cas_runner_dispatch-1",
    kind: "result",
    execution_job_id: "execution_job-1",
    status: "dispatched",
    enable_real_dispatch: true,
    endpoint_id: "default",
    workspace_dir: "/root/.openclaw/workspace/openclaw-agent-mesh-gateway",
    repo_scope: "openclaw-agent-mesh-gateway",
    policy_decision_id: "policy_decision-1",
    policy_decision: "allow-once",
    approval_policy: "ask_before_write",
    allowed_actions: [],
    forbidden_actions: ["push"],
    dispatcher_called: true,
    created_at: "2026-05-10T18:05:00.000Z",
    reason: "Invalid."
  });

  assert.equal(invalid.ok, false);
  assert.match(invalid.issues.map((issue) => issue.path).join(","), /allowed_actions/);
});

test("validates context, agent, and audit records", () => {
  assert.equal(
    validateMeshContextRecord({
      id: "domain.nestdev",
      type: "company",
      name: "NestDev",
      parent_id: "workspace.joseph",
      policy_profile: "software_business_standard",
      memory_scopes: ["domain.nestdev"],
      status: "active"
    }).ok,
    true
  );

  assert.equal(
    validateMeshAgentRecord({
      id: "agent.software_engineer",
      name: "Software Engineer",
      role: "software_engineer",
      status: "simulated",
      phase_1_active: true,
      capabilities: ["execution_job.stub"]
    }).ok,
    true
  );

  assert.equal(
    validateAuditEvent({
      id: "audit-1",
      type: "envelope.accepted",
      created_at: "2026-05-09T12:00:00.000Z",
      message_id: "msg-1",
      correlation_id: "corr-1",
      actor_id: "agent.chief_of_staff",
      details: { accepted: true }
    }).ok,
    true
  );
});
