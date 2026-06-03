import { draftHumanRequest, captureHumanDecision } from "../core/human-request-queue.js";
import { planProactivityTaskThreadFlow } from "../core/proactivity-task-thread-flow.js";
import { planConversationTurn } from "../core/conversation-orchestrator.js";
import { planDiscordBotControllerTurn } from "../core/discord-bot-controller.js";
import { canonicalInputHash } from "../core/ndjson-store.js";
import type { ProactivityFindingRecord } from "../schema/proactivity-task-thread-flow.js";

const fixedClock = {
  now() {
    return new Date("2026-05-13T17:35:00.000Z");
  }
};

export function buildAgentOsE2eDemo() {
  const finding: ProactivityFindingRecord = {
    finding_key: "openclaw-docs-indexing-gap",
    title: "OpenClaw docs indexing is incomplete for agent workflows",
    summary: "Agents need official docs indexed into memory-aware retrieval before autonomous work is reliable.",
    severity: "warning",
    privacy: "internal",
    source: "proactivity_finding",
    event: "new",
    status: "active",
    observed_at: "2026-05-13T17:35:00.000Z",
    evidence: [
      "Joseph explicitly asked for memory commands to work and docs to be indexed",
      "Current dry-run planning identifies docs indexing as a first-class Agent OS task"
    ],
    domain_hint: "openclaw",
    type_hint: "docs_indexing",
    taskflow_path: "memory/tasks/agent-mesh-bootstrap-taskflow.md",
    spec_path: "shared/projects/agent-operating-system/README.md",
    owner_agent_id: "runtime-a-controller"
  };

  const taskThreadFlow = planProactivityTaskThreadFlow({
    finding,
    discordInventory: {
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
    }
  });

  const draftedHumanRequest = draftHumanRequest(
    {
      task_id: taskThreadFlow.task_thread_plan.taskId,
      task_title: taskThreadFlow.finding.title,
      request_type: "approval",
      priority: "P1",
      owner_agent_id: "runtime-a-controller",
      canonical_state_ref: "memory/tasks/agent-mesh-bootstrap-taskflow.md",
      question: "Approve one bounded live Discord task-thread smoke test after dry-run closure?",
      recommendation: {
        option: "approve",
        rationale: "The dry-run control loop is green and the next risk is operational, not architectural."
      },
      risk: {
        risk_level: "medium",
        approval_triggers: ["discord_send", "bounded live test"],
        side_effects: ["one visible Discord thread lifecycle test"]
      },
      impact_if_unanswered: "The Agent OS remains dry-run only."
    },
    { clock: fixedClock }
  );

  const humanRequest = {
    ...draftedHumanRequest,
    request_id: "hrq_demo_agent_os_e2e"
  };

  const rawHumanDecision = captureHumanDecision(
    {
      request: humanRequest,
      decision: "approve",
      decided_by: "Joseph",
      decision_text_summary: "Approved a single bounded smoke test after dry-run completion.",
      approval_scope: {
        action: "single bounded Discord task-thread smoke test",
        target: "approved existing test surface",
        single_use: true,
        constraints: ["no new channels", "no CAS real dispatch", "no restart without separate approval"]
      },
      next_task_state: "ready_for_live_bounded_smoke",
      state_update_refs: ["memory/tasks/agent-mesh-bootstrap-taskflow.md"]
    },
    { clock: fixedClock }
  );

  const humanDecision = {
    decision: {
      ...rawHumanDecision.decision,
      decision_id: "hdec_demo_agent_os_e2e",
      request_id: humanRequest.request_id
    },
    request: {
      ...rawHumanDecision.request,
      request_id: humanRequest.request_id
    }
  };

  const workerTurn = planConversationTurn(
    {
      task_id: taskThreadFlow.task_thread_plan.taskId,
      actor_id: "yehonalbot",
      message_id: "msg-demo-complete-1",
      text: "Done, completed the assigned dry-run docs indexing analysis and prepared the next smoke-test handoff."
    },
    { clock: fixedClock }
  );

  const controllerTurn = planDiscordBotControllerTurn({
    task_id: taskThreadFlow.task_thread_plan.taskId,
    channel_id: "channel-worklog",
    actor_id: "yehonalbot",
    message_id: "msg-demo-complete-1",
    text: "Done, completed the assigned dry-run docs indexing analysis and prepared the next smoke-test handoff.",
    message_hash: canonicalInputHash("done-dry-run-docs-indexing"),
    state: {
      task_id: taskThreadFlow.task_thread_plan.taskId,
      channel_id: "channel-worklog",
      participant_allowlist: ["yehonalbot", "runtime-a-controller", "agent-alpha"],
      seen_message_ids: [],
      seen_content_hashes: [],
      turn_budget_remaining: 4,
      status: "active"
    }
  });

  return {
    demo: "agent-os-e2e-dry-run",
    generated_at: "2026-05-13T17:35:00.000Z",
    side_effects: [],
    guardrails: {
      dry_run: true,
      no_real_discord_send: true,
      no_real_cas_dispatch: true,
      no_restart: true,
      no_new_channel_creation: true
    },
    flow: {
      finding,
      task_thread_flow: {
        ...taskThreadFlow,
        task_thread_plan: {
          ...taskThreadFlow.task_thread_plan,
          auditPreview: taskThreadFlow.task_thread_plan.auditPreview.map((entry) => ({
            ...entry,
            timestamp: "2026-05-13T17:35:00.000Z"
          }))
        }
      },
      human_request: humanRequest,
      human_decision: humanDecision,
      worker_turn: workerTurn,
      controller_turn: controllerTurn
    }
  };
}

console.log(JSON.stringify(buildAgentOsE2eDemo(), null, 2));
