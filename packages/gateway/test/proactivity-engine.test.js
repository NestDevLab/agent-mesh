import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const {
  PROACTIVITY_ACTION_KINDS,
  PROACTIVITY_APPROVAL_POLICIES,
  PROACTIVITY_BACKLOG_OUTCOMES,
  PROACTIVITY_DECISIONS,
  PROACTIVITY_LOOP_KINDS,
  PROACTIVITY_RECORD_SCHEMA,
  PROACTIVITY_TRIGGER_KINDS,
  validateProactivityDecisionRecord,
  validateProactivityOutcomeRecord,
  validateProactivityRecord
} = await import("../src/schema/proactivity.ts");
const {
  ProactivityDecisionStore,
  ProactivityEventStore,
  ProactivityOutcomeStore
} = await import("../src/core/proactivity-store.ts");
const { selectStaleBacklogProposals } = await import(
  "../src/core/proactivity-selectors.ts"
);

const fixedClock = {
  now() {
    return new Date("2026-05-10T12:00:00.000Z");
  }
};

test("validates proactivity records and documented enums", () => {
  assert.deepEqual([...PROACTIVITY_TRIGGER_KINDS], [
    "scheduled",
    "heartbeat",
    "staleness",
    "failure_pattern",
    "inbox_signal",
    "human_request",
    "post_outcome_review"
  ]);
  assert.deepEqual([...PROACTIVITY_LOOP_KINDS], ["operational", "improvement"]);
  assert.ok(PROACTIVITY_ACTION_KINDS.includes("triage"));
  assert.ok(PROACTIVITY_ACTION_KINDS.includes("archive_proposal"));
  assert.ok(PROACTIVITY_ACTION_KINDS.includes("execution_job_proposal"));
  assert.deepEqual([...PROACTIVITY_BACKLOG_OUTCOMES], [
    "do",
    "defer",
    "delegate",
    "drop",
    "decide",
    "automate",
    "escalate"
  ]);
  assert.deepEqual([...PROACTIVITY_DECISIONS], [
    "record_only",
    "allow-once",
    "deny",
    "ask-human"
  ]);
  assert.deepEqual([...PROACTIVITY_APPROVAL_POLICIES], [
    "none",
    "notify",
    "ask",
    "block_until_approved"
  ]);

  const result = validateProactivityRecord({
    schema: PROACTIVITY_RECORD_SCHEMA,
    event_id: "proactivity_1",
    created_at: "2026-05-10T12:00:00.000Z",
    workspace_id: "workspace.joseph",
    domain_id: "domain.nestdev",
    project_id: "project.agent_mesh",
    task_id: "task.phase_2",
    agent_id: "agent.chief_of_staff",
    trigger_kind: "staleness",
    loop_kind: "operational",
    proposed_action_kind: "triage",
    risk_level: "low",
    approval_policy: "none",
    memory_policy_scope: "domain.nestdev",
    no_external_execution: true,
    summary: "Review stale tasks and propose explicit outcomes.",
    backlog_outcome: "decide",
    metadata: { source: "test" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.no_external_execution, true);
  assert.equal(result.value.proposed_action_kind, "triage");
});

test("rejects invalid proactivity enum values and external execution", () => {
  const result = validateProactivityRecord({
    schema: PROACTIVITY_RECORD_SCHEMA,
    event_id: "proactivity_bad",
    created_at: "2026-05-10T12:00:00.000Z",
    workspace_id: "workspace.joseph",
    domain_id: "domain.nestdev",
    agent_id: "agent.chief_of_staff",
    trigger_kind: "cron",
    loop_kind: "sidequest",
    proposed_action_kind: "send_discord_message",
    risk_level: "low",
    approval_policy: "none",
    memory_policy_scope: "domain.nestdev",
    no_external_execution: false,
    summary: "Invalid."
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map((issue) => issue.path), [
    "trigger_kind",
    "loop_kind",
    "proposed_action_kind",
    "no_external_execution"
  ]);
});

test("validates proactivity decisions and outcomes as record-only stubs", () => {
  assert.equal(
    validateProactivityDecisionRecord({
      schema: "openclaw.agent.proactivity.decision.v1",
      decision_id: "proactivity_decision_1",
      event_id: "proactivity_1",
      decision: "allow-once",
      reason: "Local proposal-only record.",
      evaluated_at: "2026-05-10T12:00:00.000Z",
      no_external_execution: true
    }).ok,
    true
  );

  assert.equal(
    validateProactivityOutcomeRecord({
      schema: "openclaw.agent.proactivity.outcome.v1",
      outcome_id: "proactivity_outcome_1",
      event_id: "proactivity_1",
      status: "proposed",
      summary: "Proposal recorded locally.",
      recorded_at: "2026-05-10T12:00:00.000Z",
      no_external_execution: true
    }).ok,
    true
  );
});

test("stale backlog selector maps items to triage, escalate, and archive proposals", () => {
  const proposals = selectStaleBacklogProposals(
    [
      {
        id: "task-unclear",
        title: "Unclear backlog item",
        workspace_id: "workspace.joseph",
        domain_id: "domain.nestdev",
        stale_since: "2026-05-01T00:00:00.000Z",
        owner_agent_id: null
      },
      {
        id: "task-blocked",
        title: "Blocked backlog item",
        workspace_id: "workspace.joseph",
        domain_id: "domain.nestdev",
        stale_since: "2026-05-01T00:00:00.000Z",
        blocked_by: "human decision"
      },
      {
        id: "task-old",
        title: "Old low-value item",
        workspace_id: "workspace.joseph",
        domain_id: "domain.nestdev",
        stale_since: "2026-05-01T00:00:00.000Z",
        low_value: true
      }
    ],
    { clock: fixedClock }
  );

  assert.deepEqual(
    proposals.map((proposal) => proposal.proposed_action_kind),
    ["triage", "escalate", "archive_proposal"]
  );
  assert.deepEqual(
    proposals.map((proposal) => proposal.backlog_outcome),
    ["decide", "escalate", "drop"]
  );
  assert.deepEqual(
    proposals.map((proposal) => proposal.no_external_execution),
    [true, true, true]
  );
  assert.deepEqual(
    proposals.map((proposal) => validateProactivityRecord(proposal).ok),
    [true, true, true]
  );
});

test("proactivity stores append and replay local NDJSON records", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agent-mesh-proactivity-"));
  const [proposal] = selectStaleBacklogProposals(
    [
      {
        id: "task-store",
        title: "Stored stale item",
        workspace_id: "workspace.joseph",
        domain_id: "domain.nestdev",
        stale_since: "2026-05-01T00:00:00.000Z"
      }
    ],
    { clock: fixedClock }
  );

  await new ProactivityEventStore({ stateDir, clock: fixedClock }).append(proposal);
  await new ProactivityDecisionStore({ stateDir, clock: fixedClock }).append({
    schema: "openclaw.agent.proactivity.decision.v1",
    decision_id: "proactivity_decision_store",
    event_id: proposal.event_id,
    decision: "record_only",
    reason: "Local selector output only.",
    evaluated_at: "2026-05-10T12:00:00.000Z",
    no_external_execution: true
  });
  await new ProactivityOutcomeStore({ stateDir, clock: fixedClock }).append({
    schema: "openclaw.agent.proactivity.outcome.v1",
    outcome_id: "proactivity_outcome_store",
    event_id: proposal.event_id,
    status: "proposed",
    summary: "Local proposal stored.",
    recorded_at: "2026-05-10T12:00:00.000Z",
    no_external_execution: true
  });

  const eventRecords = await new ProactivityEventStore({ stateDir }).list();
  const decisionRecords = await new ProactivityDecisionStore({ stateDir }).list();
  const outcomeRecords = await new ProactivityOutcomeStore({ stateDir }).list();

  assert.equal(eventRecords.length, 1);
  assert.equal(eventRecords[0].event_id, "proactivity_stale_task-store");
  assert.equal(decisionRecords[0].decision, "record_only");
  assert.equal(outcomeRecords[0].status, "proposed");
});
