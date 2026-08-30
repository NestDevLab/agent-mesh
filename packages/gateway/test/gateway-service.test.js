import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const { GatewayService } = await import("../src/core/gateway-service.ts");
const { AgentRegistry } = await import("../src/core/agent-registry.ts");
const { ContextRegistry } = await import("../src/core/context-registry.ts");
const { ApprovalStore } = await import("../src/core/approval-store.ts");
const { DeadLetterStore } = await import("../src/core/dead-letter-store.ts");
const { ExecutionJobStore } = await import("../src/core/execution-job-store.ts");

const fixedClock = {
  now() {
    return new Date("2026-05-09T12:00:00.000Z");
  }
};

test("gateway validates, persists, dispatches stub adapters, and audits delivery", async () => {
  const stateDir = await createStateDir();
  const gateway = createGateway(stateDir);

  const result = await gateway.submitEnvelope(envelope());

  assert.equal(result.duplicate, false);
  assert.equal(result.deliveries.length, 2);
  assert.deepEqual(
    result.deliveries.map((delivery) => [delivery.adapter_id, delivery.status]),
    [
      ["simulated-agent", "delivered"],
      ["discord-transcript-stub", "stubbed"]
    ]
  );

  const deliveryEvents = await gateway.getDelivery("msg-request-1");
  assert.equal(deliveryEvents.length, 6);
  assert.equal(deliveryEvents.every((delivery) => delivery.max_attempts === 1), true);

  const audit = await gateway.listAudit({ message_id: "msg-request-1" });
  assert.equal(audit.some((event) => event.type === "envelope.accepted"), true);
  assert.equal(audit.some((event) => event.type === "delivery.queued"), true);
  assert.equal(audit.some((event) => event.type === "delivery.updated"), true);
  const discordAudit = audit.find(
    (event) =>
      event.type === "delivery.updated" &&
      event.details.adapter_id === "discord-transcript-stub"
  );
  assert.equal(
    discordAudit.details.adapter_details.internal_to_discord_correlation.schema,
    "openclaw.discord_transcript_correlation.v1"
  );
  assert.equal(
    discordAudit.details.adapter_details.internal_to_discord_correlation.no_external_send,
    true
  );
});

test("an explicit session id selects the session transport without invoking the static tmux route", async () => {
  const stateDir = await createStateDir();
  const calls = [];
  const adapter = (id) => ({
    id,
    async dispatch() {
      calls.push(id);
      return { status: "delivered", details: { adapter_id: id } };
    }
  });
  const gateway = createGateway(stateDir, {
    adapters: [
      adapter("simulated-agent"),
      adapter("discord-transcript-stub"),
      adapter("tmux-transport"),
      adapter("agent-session-transport")
    ]
  });
  await gateway.submitEnvelope(envelope({
    metadata: { session_id: "session-1" }
  }));
  assert.deepEqual(calls, [
    "simulated-agent",
    "discord-transcript-stub",
    "agent-session-transport"
  ]);
});

test("gateway retries failed deliveries up to max_attempts and dead-letters exhaustion", async () => {
  const stateDir = await createStateDir();
  const failingAdapter = {
    id: "simulated-agent",
    calls: 0,
    async dispatch(delivery) {
      this.calls += 1;
      return {
        status: "failed",
        details: { attempt: delivery.attempts }
      };
    }
  };
  const gateway = createGateway(stateDir, {
    maxDeliveryAttempts: 2,
    adapters: [failingAdapter, new NoopStubAdapter("discord-transcript-stub")]
  });

  const result = await gateway.submitEnvelope(
    envelope({ message_id: "msg-fail", idempotency_key: "idem-fail" })
  );

  assert.equal(failingAdapter.calls, 2);
  const failedDelivery = result.deliveries.find(
    (delivery) => delivery.adapter_id === "simulated-agent"
  );
  assert.equal(failedDelivery.status, "failed");
  assert.equal(failedDelivery.attempts, 2);
  assert.equal(failedDelivery.max_attempts, 2);
  assert.match(failedDelivery.last_error, /max attempts exhausted/);

  const deadLetters = await new DeadLetterStore({ stateDir, clock: fixedClock }).list();
  assert.equal(deadLetters.length, 1);
  assert.equal(deadLetters[0].reason, "max_attempts_exhausted");
  assert.equal(deadLetters[0].payload.delivery.id, failedDelivery.id);

  const audit = await gateway.listAudit({ message_id: "msg-fail" });
  const deadLetterAudit = audit.find((event) => event.type === "delivery.dead_lettered");
  assert.equal(deadLetterAudit.details.delivery_id, failedDelivery.id);
  assert.equal(deadLetterAudit.details.max_attempts, 2);
});

test("gateway rejects invalid delivery transitions loudly and audits them", async () => {
  const stateDir = await createStateDir();
  const invalidAdapter = {
    id: "simulated-agent",
    async dispatch() {
      return { status: "queued", details: { invalid: true } };
    }
  };
  const gateway = createGateway(stateDir, {
    adapters: [invalidAdapter, new NoopStubAdapter("discord-transcript-stub")]
  });

  await assert.rejects(
    gateway.submitEnvelope(
      envelope({ message_id: "msg-invalid", idempotency_key: "idem-invalid" })
    ),
    /Invalid delivery transition/
  );

  const audit = await gateway.listAudit();
  const invalidTransition = audit.find((event) => event.type === "delivery.invalid_transition");
  assert.equal(invalidTransition.details.message_id, "msg-invalid");
  assert.equal(invalidTransition.details.from_status, "dispatching");
  assert.equal(invalidTransition.details.attempted_status, "queued");
});

test("gateway idempotency returns duplicates without re-dispatch", async () => {
  const stateDir = await createStateDir();
  const gateway = createGateway(stateDir);

  await gateway.submitEnvelope(envelope());
  const duplicate = await gateway.submitEnvelope(envelope());

  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.deliveries.length, 6);

  const allDeliveryEvents = await gateway.getDelivery("msg-request-1");
  assert.equal(allDeliveryEvents.length, 6);
});

test("gateway enforces agent context availability and paused kill switch", async () => {
  const stateDir = await createStateDir();
  const gateway = createGateway(stateDir, { paused: true });

  await assert.rejects(
    gateway.submitEnvelope(envelope({ message_id: "msg-paused", idempotency_key: "idem-paused" })),
    /gateway_paused/
  );

  await gateway.setPaused(false);
  await assert.rejects(
    gateway.submitEnvelope(
      envelope({
        message_id: "msg-context",
        idempotency_key: "idem-context",
        domain_id: "domain.personal"
      })
    ),
    /not enabled for context/
  );
});

test("gateway rejects unknown domain, sender, and recipient with audit evidence", async () => {
  const stateDir = await createStateDir();
  const gateway = createGateway(stateDir);

  await assertRejectedAudit(
    gateway,
    envelope({
      message_id: "msg-unknown-domain",
      idempotency_key: "idem-unknown-domain",
      domain_id: "domain.unknown"
    }),
    "unknown_or_inactive_domain_context",
    /Unknown or inactive domain context/
  );

  await assertRejectedAudit(
    gateway,
    envelope({
      message_id: "msg-unknown-sender",
      idempotency_key: "idem-unknown-sender",
      from: "agent.unknown_sender"
    }),
    "unknown_source_agent",
    /Unknown source agent/
  );

  await assertRejectedAudit(
    gateway,
    envelope({
      message_id: "msg-unknown-recipient",
      idempotency_key: "idem-unknown-recipient",
      to: "agent.unknown_recipient"
    }),
    "unknown_target_agent",
    /Unknown target agent/
  );
});

test("gateway rejects agents that are not enabled for context with audit evidence", async () => {
  const stateDir = await createStateDir();
  const gateway = createGateway(stateDir);

  await assertRejectedAudit(
    gateway,
    envelope({
      message_id: "msg-target-context",
      idempotency_key: "idem-target-context",
      domain_id: "domain.personal"
    }),
    "target_agent_not_enabled_for_context",
    /Target agent is not enabled for context/
  );

  await assertRejectedAudit(
    gateway,
    envelope({
      message_id: "msg-source-context",
      idempotency_key: "idem-source-context",
      from: "agent.software_engineer",
      to: "agent.chief_of_staff",
      domain_id: "domain.personal"
    }),
    "source_agent_not_enabled_for_context",
    /Source agent is not enabled for context/
  );
});

test("gateway anti-loop rejects ttl exhaustion and repeated ping-pong content", async () => {
  const stateDir = await createStateDir();
  const gateway = createGateway(stateDir);

  await assert.rejects(
    gateway.submitEnvelope(
      envelope({
        message_id: "msg-ttl",
        idempotency_key: "idem-ttl",
        ttl: 1,
        hop_count: 1
      })
    ),
    /ttl_exhausted/
  );

  await gateway.submitEnvelope(envelope({ content_hash: "hash-1" }));
  await assert.rejects(
    gateway.submitEnvelope(
      envelope({
        message_id: "msg-reply-loop",
        idempotency_key: "idem-reply-loop",
        from: "agent.software_engineer",
        to: "agent.chief_of_staff",
        intent: "reply",
        content_hash: "hash-1"
      })
    ),
    /repeated_bidirectional_content_hash/
  );
});

test("gateway rejects self-messages unless explicitly allowed", async () => {
  const stateDir = await createStateDir();
  const gateway = createGateway(stateDir);

  await assertRejectedAudit(
    gateway,
    envelope({
      message_id: "msg-self",
      idempotency_key: "idem-self",
      from: "agent.chief_of_staff",
      to: "agent.chief_of_staff"
    }),
    "self_message_not_allowed",
    /self_message_not_allowed/
  );

  const allowed = await gateway.submitEnvelope(
    envelope({
      message_id: "msg-self-allowed",
      idempotency_key: "idem-self-allowed",
      from: "agent.chief_of_staff",
      to: "agent.chief_of_staff",
      metadata: { allow_self_message: true }
    })
  );

  assert.equal(allowed.duplicate, false);
  assert.equal(allowed.deliveries.length, 2);
});

test("gateway blocks agent-only terminal conversation and task reopen attempts", async () => {
  const stateDir = await createStateDir();
  const gateway = createGateway(stateDir);

  await assertRejectedAudit(
    gateway,
    envelope({
      message_id: "msg-terminal-conversation-reopen",
      idempotency_key: "idem-terminal-conversation-reopen",
      metadata: {
        agent_only: true,
        reopens_terminal_conversation: true
      }
    }),
    "agent_only_terminal_reopen_not_allowed",
    /cannot reopen a terminal conversation or task/
  );

  await assertRejectedAudit(
    gateway,
    envelope({
      message_id: "msg-terminal-task-reopen",
      idempotency_key: "idem-terminal-task-reopen",
      metadata: {
        agent_only: true,
        reopens_terminal_task: true
      }
    }),
    "agent_only_terminal_reopen_not_allowed",
    /cannot reopen a terminal conversation or task/
  );

  const allowed = await gateway.submitEnvelope(
    envelope({
      message_id: "msg-terminal-reopen-allowed",
      idempotency_key: "idem-terminal-reopen-allowed",
      metadata: {
        agent_only: true,
        reopens_terminal_task: true,
        allow_terminal_reopen: true
      }
    })
  );

  assert.equal(allowed.duplicate, false);
  assert.equal(allowed.deliveries.length, 2);
});

test("gateway computes missing content hashes before anti-loop checks", async () => {
  const stateDir = await createStateDir();
  const gateway = createGateway(stateDir);

  await gateway.submitEnvelope(
    envelope({
      message_id: "msg-hash-request",
      idempotency_key: "idem-hash-request",
      content: { text: "same canonical content" }
    })
  );

  await assert.rejects(
    gateway.submitEnvelope(
      envelope({
        message_id: "msg-hash-reply",
        idempotency_key: "idem-hash-reply",
        from: "agent.software_engineer",
        to: "agent.chief_of_staff",
        intent: "reply",
        content: { text: "same canonical content" }
      })
    ),
    /repeated_bidirectional_content_hash/
  );
});

test("gateway persists paused and kill-switch state across create restart", async () => {
  const stateDir = await createStateDir();
  const firstGateway = createGateway(stateDir);

  await firstGateway.setPaused(true);
  const restartedPaused = await GatewayService.create({
    stateDir,
    clock: fixedClock,
    contextRegistry: new ContextRegistry(contexts()),
    agentRegistry: new AgentRegistry(agents())
  });

  await assert.rejects(
    restartedPaused.submitEnvelope(
      envelope({ message_id: "msg-restart-paused", idempotency_key: "idem-restart-paused" })
    ),
    /gateway_paused/
  );

  await restartedPaused.setPaused(false);
  await restartedPaused.setKillSwitch(true);
  const restartedKilled = await GatewayService.create({
    stateDir,
    clock: fixedClock,
    contextRegistry: new ContextRegistry(contexts()),
    agentRegistry: new AgentRegistry(agents())
  });

  await assert.rejects(
    restartedKilled.submitEnvelope(
      envelope({ message_id: "msg-restart-kill", idempotency_key: "idem-restart-kill" })
    ),
    /kill_switch_enabled/
  );
});

test("gateway rejects unredacted secret persistence without writing payload content", async () => {
  const stateDir = await createStateDir();
  const gateway = createGateway(stateDir);

  await assert.rejects(
    gateway.submitEnvelope(
      envelope({
        message_id: "msg-secret",
        idempotency_key: "idem-secret",
        sensitivity: "secret",
        redaction_state: "none",
        content: { text: "do not persist this" }
      })
    ),
    /secret_payload_requires_redaction/
  );

  const audit = await gateway.listAudit();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].type, "envelope.rejected");
  assert.equal(audit[0].details.reason, "secret_payload_requires_redaction");
  assert.equal(JSON.stringify(audit[0]).includes("do not persist this"), false);
});

test("gateway rejects obvious secret-shaped payload fields", async () => {
  const stateDir = await createStateDir();
  const gateway = createGateway(stateDir);

  await assert.rejects(
    gateway.submitEnvelope(
      envelope({
        message_id: "msg-token",
        idempotency_key: "idem-token",
        content: { api_key: "x" }
      })
    ),
    /obvious_secret_payload_rejected/
  );
});

test("codex runner adapter persists execution job stubs only", async () => {
  const stateDir = await createStateDir();
  const gateway = createGateway(stateDir);

  const result = await gateway.submitEnvelope(
    envelope({
      message_id: "msg-codex-1",
      idempotency_key: "idem-codex-1",
      intent: "execution_job",
      content: {
        summary: "Inspect a failing unit test.",
        policy_profile: "software_business_standard",
        endpoint_id: "runner-stub-nestdev",
        workspace_dir: "/workspace/openclaw-agent-mesh-gateway",
        repo_scope: "openclaw-agent-mesh-gateway",
        approval_profile: "phase-1-stub",
        approval_required: true,
        project_id: "project.agent_mesh",
        requested_capability: "codex.run.stub"
      }
    })
  );

  assert.deepEqual(
    result.deliveries.map((delivery) => [delivery.adapter_id, delivery.status]),
    [
      ["discord-transcript-stub", "stubbed"],
      ["runner-stub", "stubbed"]
    ]
  );

  const jobs = await new ExecutionJobStore({ stateDir, clock: fixedClock }).list();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "stubbed");
  assert.equal(jobs[0].request.endpoint_id, "runner-stub-nestdev");
  assert.equal(jobs[0].request.workspace_dir, "/workspace/openclaw-agent-mesh-gateway");
  assert.equal(jobs[0].request.approval_profile, "phase-1-stub");
  assert.equal(jobs[0].request.conversation_id, "conversation-1");
  assert.equal(jobs[0].request.correlation_id, "corr-1");
  assert.equal(jobs[0].request.source_message_id, "msg-codex-1");
  assert.equal(jobs[0].request.project_id, "project.agent_mesh");
  assert.equal(jobs[0].governance.decision, "record_only");
  assert.equal(jobs[0].governance.approval_status, "required_stubbed");
  assert.equal(jobs[0].governance.approval.request.subject_kind, "execution_job");
  assert.equal(jobs[0].governance.approval.decision.decision, "ask-human");
  assert.equal(jobs[0].governance.approval.decision.human_escalation_required, true);
  assert.equal(jobs[0].governance.no_external_execution, true);
  assert.equal(jobs[0].governance.workspace_id, "workspace.the operator");
  assert.equal(jobs[0].governance.domain_id, "domain.nestdev");

  const approvals = await new ApprovalStore({ stateDir, clock: fixedClock }).list();
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].request.subject_id, jobs[0].id);
  assert.equal(approvals[0].decision.status, "requires_human_stubbed");

  const audit = await gateway.listAudit({ message_id: "msg-codex-1" });
  assert.equal(audit.some((event) => event.type === "approval.requested"), true);
  assert.equal(audit.some((event) => event.type === "approval.decided"), true);
});

test("codex execution job approval gate records allow-once and deny decisions locally", async () => {
  const stateDir = await createStateDir();
  const gateway = createGateway(stateDir);

  const allowed = await gateway.createCodexExecutionJobStub({
    requested_by_agent_id: "agent.software_engineer",
    workspace_id: "workspace.the operator",
    domain_id: "domain.nestdev",
    summary: "Record a safe local stub job.",
    policy_profile: "software_business_standard",
    endpoint_id: "runner-stub-local",
    workspace_dir: "/workspace/openclaw-agent-mesh-gateway",
    repo_scope: "openclaw-agent-mesh-gateway",
    approval_profile: "phase-2-local-stub",
    approval_required: false
  });

  const denied = await gateway.createCodexExecutionJobStub({
    requested_by_agent_id: "agent.software_engineer",
    workspace_id: "workspace.the operator",
    domain_id: "domain.nestdev",
    summary: "Record a denied local stub job.",
    policy_profile: "deny_all",
    endpoint_id: "runner-stub-local",
    workspace_dir: "/workspace/openclaw-agent-mesh-gateway",
    repo_scope: "openclaw-agent-mesh-gateway",
    approval_profile: "phase-2-local-stub",
    approval_required: false
  });

  assert.equal(allowed.status, "stubbed");
  assert.equal(allowed.governance.approval_status, "approved_stubbed");
  assert.equal(allowed.governance.approval.decision.decision, "allow-once");
  assert.equal(denied.status, "blocked");
  assert.equal(denied.governance.decision, "blocked_by_policy");
  assert.equal(denied.governance.approval_status, "denied_stubbed");
  assert.equal(denied.governance.approval.decision.decision, "deny");

  const approvals = await gateway.listApprovalEvaluations();
  assert.deepEqual(
    approvals.map((approval) => approval.decision.decision),
    ["allow-once", "deny"]
  );

  const audit = await gateway.listAudit();
  assert.equal(audit.filter((event) => event.type === "approval.requested").length, 2);
  assert.equal(audit.filter((event) => event.type === "approval.decided").length, 2);
});

test("codex runner adapter records pause and cancel intents without contacting runner", async () => {
  const stateDir = await createStateDir();
  const gateway = createGateway(stateDir);

  await gateway.submitEnvelope(
    envelope({
      message_id: "msg-codex-pause",
      idempotency_key: "idem-codex-pause",
      intent: "execution_job",
      content: {
        summary: "Pause the current stub job.",
        policy_profile: "software_business_standard",
        endpoint_id: "runner-stub-nestdev",
        workspace_dir: "/workspace/openclaw-agent-mesh-gateway",
        repo_scope: "openclaw-agent-mesh-gateway",
        approval_profile: "phase-1-stub",
        control_intent: "pause"
      }
    })
  );

  await gateway.submitEnvelope(
    envelope({
      message_id: "msg-codex-cancel",
      idempotency_key: "idem-codex-cancel",
      intent: "execution_job",
      content: {
        summary: "Cancel the current stub job.",
        policy_profile: "software_business_standard",
        endpoint_id: "runner-stub-nestdev",
        workspace_dir: "/workspace/openclaw-agent-mesh-gateway",
        repo_scope: "openclaw-agent-mesh-gateway",
        approval_profile: "phase-1-stub",
        control_intent: "cancel"
      }
    })
  );

  const jobs = await new ExecutionJobStore({ stateDir, clock: fixedClock }).list();
  assert.deepEqual(
    jobs.map((job) => [job.status, job.governance.decision, job.governance.no_external_execution]),
    [
      ["pause_requested", "pause_requested", true],
      ["cancel_requested", "cancel_requested", true]
    ]
  );
});

class NoopStubAdapter {
  constructor(id) {
    this.id = id;
  }

  async dispatch(delivery) {
    return {
      status: "stubbed",
      external_id: `${this.id}:${delivery.id}`,
      details: { no_external_send: true }
    };
  }
}

function createGateway(stateDir, overrides = {}) {
  return new GatewayService({
    stateDir,
    clock: fixedClock,
    contextRegistry: new ContextRegistry(contexts()),
    agentRegistry: new AgentRegistry(agents()),
    ...overrides
  });
}

function envelope(overrides = {}) {
  return {
    schema: "openclaw.agent.message.v1",
    message_id: "msg-request-1",
    created_at: "2026-05-09T11:59:00.000Z",
    workspace_id: "workspace.the operator",
    domain_id: "domain.nestdev",
    conversation_id: "conversation-1",
    from: "agent.chief_of_staff",
    to: "agent.software_engineer",
    intent: "request",
    ttl: 4,
    hop_count: 0,
    idempotency_key: "idem-request-1",
    content: { text: "Inspect the failing test." },
    correlation_id: "corr-1",
    ...overrides
  };
}

async function assertRejectedAudit(gateway, input, reason, errorPattern) {
  await assert.rejects(gateway.submitEnvelope(input), errorPattern);
  const audit = await gateway.listAudit({ message_id: input.message_id });
  const rejected = audit.find((event) => event.type === "envelope.rejected");

  assert.ok(rejected, `missing envelope.rejected audit for ${input.message_id}`);
  assert.equal(rejected.details.reason, reason);
  assert.equal(rejected.message_id, input.message_id);
  assert.equal(rejected.actor_id, input.from);
  assert.equal(rejected.correlation_id, input.correlation_id);
}

function contexts() {
  return [
    {
      id: "workspace.the operator",
      type: "workspace",
      name: "Example Workspace",
      parent_id: null,
      owner_human: "the operator",
      policy_profile: "workspace_standard",
      status: "active"
    },
    {
      id: "domain.nestdev",
      type: "company",
      name: "NestDev",
      parent_id: "workspace.the operator",
      policy_profile: "software_business_standard",
      status: "active"
    },
    {
      id: "domain.personal",
      type: "personal",
      name: "Personal",
      parent_id: "workspace.the operator",
      policy_profile: "personal_private",
      status: "active"
    }
  ];
}

function agents() {
  return [
    {
      id: "agent.chief_of_staff",
      name: "Chief of Staff",
      role: "orchestration",
      status: "simulated",
      phase_1_active: true,
      capabilities: ["route_request"],
      enabled_contexts: ["workspace.the operator", "domain.nestdev", "domain.personal"]
    },
    {
      id: "agent.software_engineer",
      name: "Software Engineer",
      role: "software_engineering",
      status: "simulated",
      phase_1_active: true,
      capabilities: ["propose_codex_execution_job_stub"],
      enabled_contexts: ["domain.nestdev"]
    }
  ];
}

async function createStateDir() {
  return mkdtemp(join(tmpdir(), "agent-mesh-gateway-"));
}
