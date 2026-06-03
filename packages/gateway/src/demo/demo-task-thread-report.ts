import { planTaskThreadReportDryRun } from "../core/task-thread-reporter.js";

const plan = planTaskThreadReportDryRun({
  task: {
    id: "AO-002",
    title: "Task Thread Reporter Dry-Run",
    source: "manual_test",
    domainHint: "agent_os",
    typeHint: "agent_os_implementation",
    privacy: "internal",
    lifecycle: {
      status: "opened",
      nextAction: "Implement dry-run placement planner and tests."
    },
    links: {
      taskflowPath: "/root/.openclaw/workspace/memory/tasks/agent-mesh-bootstrap-taskflow.md",
      specPath: "/root/.openclaw/workspace/shared/projects/agent-operating-system/discord-placement-map.md"
    }
  },
  discordInventory: {
    categories: [
      {
        id: "category-agent-os",
        name: "Agent OS",
        channels: [
          {
            id: "channel-agent-os-worklog",
            name: "agent-os-worklog",
            type: "text",
            topic: "Agent OS task lifecycle logs"
          }
        ]
      }
    ]
  }
});

console.log(JSON.stringify(plan, null, 2));
