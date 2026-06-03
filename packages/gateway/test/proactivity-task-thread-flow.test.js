import assert from "node:assert/strict";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const {
  validateProactivityFindingRecord
} = await import("../src/schema/proactivity-task-thread-flow.ts");
const {
  planProactivityTaskThreadFlow
} = await import("../src/core/proactivity-task-thread-flow.ts");

test("AO-012 plans a visible task-thread update for a new actionable finding", () => {
  const plan = planProactivityTaskThreadFlow({
    finding: finding({
      finding_key: "discord:missing-access",
      title: "Discord Missing Access delivery failures",
      summary: "Delivery retry failures require investigation.",
      severity: "critical",
      event: "new",
      status: "active",
      domain_hint: "openclaw"
    }),
    discordInventory: inventory()
  });

  assert.equal(plan.dry_run, true);
  assert.equal(plan.suppression.suppressed, false);
  assert.equal(plan.notify_in_discord, true);
  assert.equal(plan.task_thread_plan.classification.domain, "openclaw");
  assert.equal(plan.task_thread_plan.placement.channel?.name, "agent-os-incidents");
});

test("unchanged finding is suppressed during cooldown", () => {
  const plan = planProactivityTaskThreadFlow({
    finding: finding({
      finding_key: "discord:delivery-signal",
      title: "Delivery warning signal",
      summary: "Known repeated signal without new evidence.",
      severity: "warning",
      event: "unchanged",
      status: "active",
      domain_hint: "openclaw"
    }),
    discordInventory: inventory(),
    cooldownActive: true
  });

  assert.equal(plan.suppression.suppressed, true);
  assert.equal(plan.notify_in_discord, false);
  assert.equal(plan.state_transition.to, "suppressed");
});

test("resolved finding maps to completed task status", () => {
  const plan = planProactivityTaskThreadFlow({
    finding: finding({
      finding_key: "memory-core:cron-service-unavailable",
      title: "Memory core cron warning resolved",
      summary: "The warning is no longer active.",
      severity: "warning",
      event: "resolved",
      status: "resolved",
      domain_hint: "openclaw"
    }),
    discordInventory: inventory()
  });

  assert.equal(plan.task_status, "completed");
  assert.equal(plan.state_transition.to, "resolved");
});

test("finding validation rejects missing evidence", () => {
  const result = validateProactivityFindingRecord({
    finding_key: "x",
    title: "x",
    summary: "x",
    severity: "warning",
    privacy: "internal",
    source: "proactivity_finding",
    event: "new",
    status: "active",
    observed_at: "2026-05-13T13:40:00.000Z"
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.path === "evidence"));
});

function finding(overrides = {}) {
  return {
    finding_key: "finding-1",
    title: "OpenClaw sanity finding",
    summary: "A new finding needs a task-thread plan.",
    severity: "warning",
    privacy: "internal",
    source: "proactivity_finding",
    event: "new",
    status: "active",
    observed_at: "2026-05-13T13:40:00.000Z",
    evidence: ["first observed in sanity adapter"],
    ...overrides
  };
}

function inventory() {
  return {
    categories: [
      {
        id: "category-agent-os",
        name: "Agent OS",
        channels: [
          { id: "channel-worklog", name: "agent-os-worklog", type: "text", topic: "Task lifecycle" },
          { id: "channel-requests", name: "agent-os-requests", type: "text", topic: "Approvals" },
          { id: "channel-incidents", name: "agent-os-incidents", type: "text", topic: "Incidents" }
        ]
      }
    ]
  };
}
