import assert from "node:assert/strict";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const { planTaskThreadReportDryRun } = await import("../src/core/task-thread-reporter.ts");

const fixedClock = {
  now() {
    return new Date("2026-05-13T10:55:00.000Z");
  }
};

test("AO-002 routes to Agent OS implementation in an existing channel", () => {
  const plan = planTaskThreadReportDryRun(
    {
      task: task({ id: "AO-002", title: "Task Thread Reporter Dry-Run" }),
      discordInventory: inventory()
    },
    { clock: fixedClock }
  );

  assert.equal(plan.dryRun, true);
  assert.deepEqual(plan.sideEffects, []);
  assert.equal(plan.taskId, "AO-002");
  assert.equal(plan.classification.domain, "agent_os");
  assert.equal(plan.classification.taskType, "agent_os_implementation");
  assert.equal(plan.orchestration.strategy, "internal");
  assert.equal(plan.placement.decision, "create_thread_in_existing_channel");
  assert.equal(plan.placement.channel?.name, "agent-os-worklog");
  assert.equal(plan.placement.thread?.title, "AO-002 Task Thread Reporter Dry-Run");
  assert.ok(plan.messagePlan.every((message) => message.send === false));
  assert.equal(plan.auditPreview[0].timestamp, "2026-05-13T10:55:00.000Z");
});

test("existing thread reuse wins over new thread proposal", () => {
  const inv = inventory({ includeAoThread: true });
  const plan = planTaskThreadReportDryRun({ task: task({ id: "AO-002" }), discordInventory: inv });

  assert.equal(plan.placement.decision, "reuse_existing_thread");
  assert.equal(plan.placement.thread?.id, "thread-ao-002");
  assert.equal(plan.placement.needsApproval, false);
});

test("empty inventory blocks safely when new channel proposals are disabled", () => {
  const plan = planTaskThreadReportDryRun({
    task: task({ id: "AO-099", title: "Unknown planning task" }),
    discordInventory: { categories: [] },
    rules: { allowNewChannelProposal: false }
  });

  assert.equal(plan.placement.decision, "blocked_needs_human_mapping");
  assert.equal(plan.placement.needsApproval, true);
  assert.ok(plan.messagePlan.some((message) => message.lifecycleEvent === "approval_request"));
  assert.ok(plan.warnings.some((warning) => warning.includes("No suitable")));
});

test("critical OpenClaw finding routes as incident/status", () => {
  const plan = planTaskThreadReportDryRun({
    task: task({
      id: "OC-777",
      title: "Fatal heap OOM signal in OpenClaw sanity",
      source: "proactivity_finding",
      severity: "critical"
    }),
    discordInventory: inventory()
  });

  assert.equal(plan.classification.domain, "openclaw");
  assert.equal(plan.classification.taskType, "incident");
  assert.equal(plan.placement.channel?.name, "agent-os-incidents");
});

test("ChromieCraft/Yehonal tasks choose a Discord-mediated strategy", () => {
  const plan = planTaskThreadReportDryRun({
    task: task({
      id: "CC-012",
      title: "YehonalBot inspect ChromieCraft containers",
      domainHint: "chromiecraft"
    }),
    discordInventory: inventory()
  });

  assert.equal(plan.classification.domain, "chromiecraft");
  assert.equal(plan.orchestration.strategy, "hybrid");
  assert.deepEqual(plan.orchestration.allowedStrategies, ["discord_bot_to_bot", "hybrid"]);
  assert.ok(plan.warnings.some((warning) => warning.includes("External Discord bot")));
});

test("approval tasks target request-channel message plan", () => {
  const plan = planTaskThreadReportDryRun({
    task: task({
      id: "AO-004",
      title: "Approval needed for bounded live Discord test",
      typeHint: "approval",
      lifecycle: { status: "approval_needed" }
    }),
    discordInventory: inventory()
  });

  assert.equal(plan.classification.taskType, "approval");
  assert.equal(plan.placement.channel?.name, "agent-os-requests");
  assert.ok(plan.messagePlan.some((message) => message.lifecycleEvent === "approval_request" && message.target === "request_channel"));
});

function task(overrides = {}) {
  return {
    id: "AO-002",
    title: "Task Thread Reporter Dry-Run",
    source: "human_request",
    privacy: "internal",
    ...overrides
  };
}

function inventory(options = {}) {
  const channels = [
    { id: "channel-worklog", name: "agent-os-worklog", type: "text", topic: "Agent OS task lifecycle logs" },
    { id: "channel-requests", name: "agent-os-requests", type: "text", topic: "Approvals and Joseph decisions" },
    { id: "channel-incidents", name: "agent-os-incidents", type: "text", topic: "OpenClaw incident status and critical findings" },
    { id: "channel-chromie", name: "chromiecraft-ops", type: "text", topic: "ChromieCraft and YehonalBot operations" }
  ];

  if (options.includeAoThread) {
    channels.push({
      id: "thread-ao-002",
      name: "AO-002 Task Thread Reporter Dry-Run",
      type: "thread",
      threadMetadata: {
        parentChannelId: "channel-worklog",
        title: "AO-002 Task Thread Reporter Dry-Run",
        status: "open"
      }
    });
  }

  return {
    categories: [
      {
        id: "category-agent-os",
        name: "Agent OS",
        channels
      }
    ]
  };
}
