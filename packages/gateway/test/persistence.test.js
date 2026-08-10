import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const {
  AuditStore,
  ApprovalStore,
  DeliveryStore,
  DiscordDeliveryPlanStore,
  EnvelopeStore,
  ExecutionJobStore,
  HeartbeatStore,
  IdempotencyStore,
  recoverStartupState
} = await loadPersistenceModules();

const fixedClock = {
  now() {
    return new Date("2026-05-09T12:00:00.000Z");
  }
};

test("append and replay preserve event metadata and payloads", async () => {
  const stateDir = await createStateDir();
  const store = new AuditStore({ stateDir, clock: fixedClock });

  await store.append({
    id: "audit_1",
    type: "envelope.accepted",
    created_at: "2026-05-09T12:00:00.000Z",
    message_id: "msg_1",
    correlation_id: "corr_1",
    actor_id: "agent.chief_of_staff",
    details: { ok: true }
  });

  const replay = await store.replay();
  assert.equal(replay.warnings.length, 0);
  assert.equal(replay.records.length, 1);
  assert.equal(replay.records[0].event_id, "audit_1");
  assert.equal(replay.records[0].event_type, "envelope.accepted");
  assert.equal(replay.records[0].schema_version, "agent-mesh.store-event.v1");
  assert.equal(replay.records[0].created_at, "2026-05-09T12:00:00.000Z");
  assert.equal(replay.records[0].data.message_id, "msg_1");

  const filtered = await store.list({ message_id: "msg_1" });
  assert.equal(filtered.length, 1);
});

test("replay ignores and quarantines a corrupt final NDJSON line", async () => {
  const stateDir = await createStateDir();
  const store = new DeliveryStore({ stateDir, clock: fixedClock });

  await store.append({
    id: "delivery_1",
    message_id: "msg_1",
    adapter_id: "adapter.simulated",
    target_agent_id: "agent.software_engineer",
    status: "queued",
    attempts: 0,
    max_attempts: 1,
    created_at: "2026-05-09T12:00:00.000Z",
    updated_at: "2026-05-09T12:00:00.000Z"
  });

  const filePath = join(stateDir, "delivery-events.ndjson");
  await appendFile(filePath, "{\"event_id\":\"broken\"");

  const replay = await store.replay();
  assert.equal(replay.records.length, 1);
  assert.equal(replay.records[0].data.id, "delivery_1");
  assert.equal(replay.warnings.length, 1);
  assert.equal(replay.warnings[0].reason, "corrupt_ndjson_line");
  assert.match(replay.warnings[0].quarantined_path, /delivery-events\.ndjson\.corrupt-final-line$/);

  const remaining = await readFile(filePath, "utf8");
  assert.equal(remaining.trim().split("\n").length, 1);
});

test("idempotency detects duplicates and conflicts by canonical input hash", async () => {
  const stateDir = await createStateDir();
  const store = new IdempotencyStore({ stateDir, clock: fixedClock });

  assert.deepEqual(await store.checkAndRemember("idem_1", { b: 2, a: 1 }), {
    status: "new",
    key: "idem_1",
    input_hash: await hashFromDecision(store, "idem_1", { a: 1, b: 2 })
  });

  const duplicate = await store.checkAndRemember("idem_1", { a: 1, b: 2 });
  assert.equal(duplicate.status, "duplicate");

  const conflict = await store.checkAndRemember("idem_1", { a: 1, b: 3 });
  assert.equal(conflict.status, "conflict");
  assert.notEqual(conflict.input_hash, conflict.existing_hash);
});

test("idempotency duplicate detection survives restart hydration", async () => {
  const stateDir = await createStateDir();
  const firstStore = new IdempotencyStore({ stateDir, clock: fixedClock });
  await firstStore.checkAndRemember("restart_key", {
    message_id: "msg_restart",
    payload: { text: "hello" }
  });

  const restartedStore = new IdempotencyStore({ stateDir, clock: fixedClock });
  const decision = await restartedStore.checkAndRemember("restart_key", {
    payload: { text: "hello" },
    message_id: "msg_restart"
  });

  assert.equal(decision.status, "duplicate");
});

test("startup recovery summary reports gateway recovered counts", async () => {
  const stateDir = await createStateDir();

  await new EnvelopeStore({ stateDir, clock: fixedClock }).append({
    version: "openclaw.agent.message.v1",
    message_id: "msg_1",
    correlation_id: "corr_1",
    created_at: "2026-05-09T12:00:00.000Z",
    source_agent_id: "agent.chief_of_staff",
    target_agent_id: "agent.software_engineer",
    workspace_id: "workspace.the operator",
    domain_id: "domain.nestdev",
    intent: "request",
    ttl: 4,
    hop_count: 0,
    payload: { text: "demo" }
  });
  await new ExecutionJobStore({ stateDir, clock: fixedClock }).append({
    id: "job_1",
    status: "stubbed",
    runner: "codex-stub",
    request: {
      requested_by_agent_id: "agent.software_engineer",
      workspace_id: "workspace.the operator",
      domain_id: "domain.nestdev",
      summary: "stub",
      policy_profile: "software_business_standard",
      endpoint_id: "runner-stub-local",
      workspace_dir: "/workspace/stub",
      repo_scope: "openclaw-agent-mesh-gateway",
      approval_profile: "stub-no-external-actions"
    },
    governance: {
      decision: "record_only",
      policy_profile: "software_business_standard",
      approval_profile: "stub-no-external-actions",
      approval_status: "not_required",
      no_external_execution: true,
      reason: "runner is stub-only.",
      evaluated_at: "2026-05-09T12:00:00.000Z",
      workspace_id: "workspace.the operator",
      domain_id: "domain.nestdev"
    },
    created_at: "2026-05-09T12:00:00.000Z",
    updated_at: "2026-05-09T12:00:00.000Z"
  });
  await new HeartbeatStore({ stateDir, clock: fixedClock }).append({
    id: "heartbeat_1",
    agent_id: "agent.software_engineer",
    status: "simulated",
    observed_at: "2026-05-09T12:00:00.000Z"
  });
  await new DiscordDeliveryPlanStore({ stateDir, clock: fixedClock }).append({
    id: "discord_delivery_plan_1",
    message_kind: "approval_request",
    workspace_id: "workspace.the operator",
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
    risk_flags: ["stub-only", "no-external-send"],
    dry_run: true,
    no_external_send: true,
    adapter_flags: {
      discord_adapter_called: false,
      openclaw_message_tool_called: false,
      discord_objects_mutated: false
    },
    created_at: "2026-05-09T12:00:00.000Z"
  });

  const summary = await recoverStartupState({ stateDir, clock: fixedClock });
  assert.deepEqual(summary.gateway.recovered, {
    audit_events: 0,
    delivery_events: 0,
    discord_delivery_plans: 1,
    envelopes: 1,
    idempotency_events: 0,
    execution_jobs: 1,
    approval_events: 0,
    runner_plans: 0,
    heartbeats: 1,
    dead_letter_records: 0,
    gateway_control_events: 0
  });
  assert.deepEqual(summary.gateway.warnings, []);

  const audit = await new AuditStore({ stateDir, clock: fixedClock }).list({
    type: "gateway.recovered"
  });
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0].details.recovered, summary.gateway.recovered);
  assert.equal(audit[0].details.warning_count, 0);
});

async function createStateDir() {
  return mkdtemp(join(tmpdir(), "agent-mesh-persistence-"));
}

async function hashFromDecision(store, key, value) {
  const decision = await store.check(key, value);
  return decision.input_hash;
}

async function loadPersistenceModules() {
  const [
    auditStore,
    approvalStore,
    runnerPlanStore,
    deliveryStore,
    discordDeliveryPlanStore,
    envelopeStore,
    executionJobStore,
    heartbeatStore,
    idempotencyStore,
    recoverySummary
  ] = await Promise.all([
    import("../src/core/audit-store.ts"),
    import("../src/core/approval-store.ts"),
    import("../src/core/runner-plan-store.ts"),
    import("../src/core/delivery-store.ts"),
    import("../src/core/discord-delivery-plan-store.ts"),
    import("../src/core/envelope-store.ts"),
    import("../src/core/execution-job-store.ts"),
    import("../src/core/heartbeat-store.ts"),
    import("../src/core/idempotency-store.ts"),
    import("../src/core/recovery-summary.ts")
  ]);

  return {
    AuditStore: auditStore.AuditStore,
    ApprovalStore: approvalStore.ApprovalStore,
    RunnerPlanStore: runnerPlanStore.RunnerPlanStore,
    DeliveryStore: deliveryStore.DeliveryStore,
    DiscordDeliveryPlanStore: discordDeliveryPlanStore.DiscordDeliveryPlanStore,
    EnvelopeStore: envelopeStore.EnvelopeStore,
    ExecutionJobStore: executionJobStore.ExecutionJobStore,
    HeartbeatStore: heartbeatStore.HeartbeatStore,
    IdempotencyStore: idempotencyStore.IdempotencyStore,
    recoverStartupState: recoverySummary.recoverStartupState
  };
}
