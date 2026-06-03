import assert from "node:assert/strict";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const {
  HUMAN_REQUEST_SCHEMA,
  HUMAN_DECISION_SCHEMA,
  validateHumanRequestRecord,
  validateHumanDecisionRecord
} = await import("../src/schema/human-request.ts");
const {
  draftHumanRequest,
  transitionHumanRequestStatus,
  captureHumanDecision
} = await import("../src/core/human-request-queue.ts");

const fixedClock = {
  now() {
    return new Date("2026-05-13T13:40:00.000Z");
  }
};

test("draftHumanRequest produces a valid dry-run human request", () => {
  const request = draftHumanRequest(
    {
      task_id: "AO-004",
      task_title: "Human Request Queue",
      request_type: "approval",
      priority: "P1",
      owner_agent_id: "karan-controller",
      canonical_state_ref: "memory/tasks/agent-mesh-bootstrap-taskflow.md",
      question: "Approve bounded live Discord test?",
      recommendation: {
        option: "approve",
        rationale: "The thread reporter already passed dry-run tests."
      },
      risk: {
        risk_level: "medium",
        approval_triggers: ["discord_send"],
        side_effects: ["one bounded task-thread message"]
      },
      impact_if_unanswered: "AO-003 remains blocked."
    },
    { clock: fixedClock }
  );

  assert.equal(request.schema, HUMAN_REQUEST_SCHEMA);
  assert.equal(request.status, "drafted");
  assert.equal(request.created_at, "2026-05-13T13:40:00.000Z");
  assert.ok(request.idempotency_key.startsWith("human_request:"));
  assert.equal(validateHumanRequestRecord(request).ok, true);
});

test("transitionHumanRequestStatus updates status and timestamp safely", () => {
  const request = draftHumanRequest(
    {
      task_id: "AO-004",
      task_title: "Human Request Queue",
      request_type: "decision",
      priority: "P2",
      owner_agent_id: "karan-controller",
      canonical_state_ref: "memory/tasks/agent-mesh-bootstrap-taskflow.md",
      question: "Which request channel should Agent OS use?",
      recommendation: { option: "ask_more", rationale: "Need Joseph preference." },
      risk: {
        risk_level: "low",
        approval_triggers: ["preference"],
        side_effects: []
      },
      impact_if_unanswered: "Queue surface remains ambiguous."
    },
    { clock: fixedClock }
  );

  const updated = transitionHumanRequestStatus(request, "awaiting_human", { clock: fixedClock });
  assert.equal(updated.status, "awaiting_human");
  assert.equal(validateHumanRequestRecord(updated).ok, true);
});

test("captureHumanDecision records decision and updates request state", () => {
  const request = draftHumanRequest(
    {
      task_id: "AO-003",
      task_title: "Task Thread Reporter Bounded Live Test",
      request_type: "approval",
      priority: "P1",
      owner_agent_id: "karan-controller",
      canonical_state_ref: "memory/tasks/agent-mesh-bootstrap-taskflow.md",
      question: "Approve one bounded live test?",
      recommendation: { option: "approve", rationale: "Dry-run is complete." },
      risk: {
        risk_level: "medium",
        approval_triggers: ["discord_send"],
        side_effects: ["single thread message"]
      },
      impact_if_unanswered: "Live test remains blocked."
    },
    { clock: fixedClock }
  );

  const { decision, request: updatedRequest } = captureHumanDecision(
    {
      request,
      decision: "approve",
      decided_by: "Joseph",
      decision_text_summary: "Approved one bounded live test.",
      approval_scope: {
        action: "post one bounded lifecycle message",
        target: "approved test thread",
        single_use: true,
        constraints: ["no CAS", "no new channels"]
      },
      next_task_state: "task_resumed",
      state_update_refs: ["memory/tasks/agent-mesh-bootstrap-taskflow.md"]
    },
    { clock: fixedClock }
  );

  assert.equal(decision.schema, HUMAN_DECISION_SCHEMA);
  assert.equal(updatedRequest.status, "approved");
  assert.equal(validateHumanDecisionRecord(decision).ok, true);
});

test("human request validation rejects malformed replies array", () => {
  const result = validateHumanRequestRecord({
    schema: HUMAN_REQUEST_SCHEMA,
    request_id: "hrq_1",
    task_id: "AO-004",
    task_title: "Queue",
    request_type: "approval",
    priority: "P1",
    status: "drafted",
    owner_agent_id: "karan-controller",
    created_at: "2026-05-13T13:40:00.000Z",
    updated_at: "2026-05-13T13:40:00.000Z",
    canonical_state_ref: "memory/tasks/agent-mesh-bootstrap-taskflow.md",
    question: "x",
    recommendation: { option: "approve", rationale: "x" },
    risk: { risk_level: "low", approval_triggers: [], side_effects: [] },
    impact_if_unanswered: "x",
    allowed_replies: ["approve", "wrong"],
    idempotency_key: "id"
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.path === "allowed_replies[1]"));
});
