import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeConfig, planDiscordBridgeTurn, planDiscordEventTaskTurn, planMeshV1Dispatch, planRuntimeAction } from "@openclaw-agent-mesh/core/policy";

async function appendAudit(cfg, record) {
  if (!cfg.audit.enabled) return;
  const fullPath = path.resolve(process.cwd(), cfg.audit.path);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await appendFile(fullPath, `${JSON.stringify({ ...record, observedAt: new Date().toISOString() })}\n`, "utf8");
}

export default definePluginEntry({
  id: "agent-mesh-wrapper",
  name: "Agent Mesh Wrapper",
  description: "Planning wrapper for Agent Mesh runtime actions",
  register(api) {
    const cfg = normalizeConfig(api.pluginConfig || {});
    if (!cfg.enabled) {
      api.logger.info("agent-mesh-wrapper: disabled");
      return;
    }

    api.registerTool(() => ({
      name: "agent_mesh_plan_runtime_action",
      label: "Agent Mesh Plan Runtime Action",
      description: "Plan an Agent Mesh runtime action through the wrapper policy without executing side effects.",
      parameters: {
        type: "object",
        additionalProperties: true,
        properties: {
          kind: { type: "string", enum: ["cas_dispatch", "discord_send", "discord_bridge_turn", "discord_mention_correction", "discord_event_task_turn", "mesh_v1_dispatch"] }
        },
        required: ["kind"]
      },
      displaySummary: "Plan an Agent Mesh action without side effects.",
      async execute(_toolCallId, input = {}) {
        const plan = planRuntimeAction(cfg, input);
        await appendAudit(cfg, { type: "agent_mesh.plan_runtime_action", input, plan });
        return { content: [{ type: "text", text: JSON.stringify(plan, null, 2) }] };
      }
    }), { name: "agent_mesh_plan_runtime_action" });

    api.registerTool(() => ({
      name: "agent_mesh_plan_discord_bridge_turn",
      label: "Agent Mesh Plan Discord Bridge Turn",
      description: "Validate and plan one controller-mediated Discord bot handoff without forwarding messages or executing side effects.",
      parameters: {
        type: "object",
        additionalProperties: true,
        properties: {
          request: { type: "object", additionalProperties: true }
        }
      },
      displaySummary: "Validate a Discord bridge handoff without side effects.",
      async execute(_toolCallId, input = {}) {
        const plan = planDiscordBridgeTurn(cfg, input);
        await appendAudit(cfg, { type: "agent_mesh.plan_discord_bridge_turn", input, plan });
        return { content: [{ type: "text", text: JSON.stringify(plan, null, 2) }] };
      }
    }), { name: "agent_mesh_plan_discord_bridge_turn" });

    api.registerTool(() => ({
      name: "agent_mesh_plan_discord_event_task_turn",
      label: "Agent Mesh Plan Discord Event Task Turn",
      description: "Validate and plan one event-driven Discord task turn without forwarding messages or executing side effects.",
      parameters: {
        type: "object",
        additionalProperties: true,
        properties: {
          request: { type: "object", additionalProperties: true },
          state: { type: "object", additionalProperties: true }
        }
      },
      displaySummary: "Validate an event-driven Discord task turn without side effects.",
      async execute(_toolCallId, input = {}) {
        const plan = planDiscordEventTaskTurn(cfg, input);
        await appendAudit(cfg, { type: "agent_mesh.plan_discord_event_task_turn", input, plan });
        return { content: [{ type: "text", text: JSON.stringify(plan, null, 2) }] };
      }
    }), { name: "agent_mesh_plan_discord_event_task_turn" });

    api.registerTool(() => ({
      name: "agent_mesh_plan_mesh_v1_dispatch",
      label: "Agent Mesh Plan Mesh v1 Dispatch",
      description: "Parse Mesh v1 headers and plan pre-dispatch buffering or exactly-once final dispatch without executing side effects.",
      parameters: {
        type: "object",
        additionalProperties: true,
        properties: {
          text: { type: "string" },
          messageId: { type: "string" },
          state: { type: "object", additionalProperties: true }
        },
        required: ["text"]
      },
      displaySummary: "Plan Mesh v1 pre-dispatch handling without side effects.",
      async execute(_toolCallId, input = {}) {
        const plan = planMeshV1Dispatch(cfg, input);
        await appendAudit(cfg, { type: "agent_mesh.plan_mesh_v1_dispatch", input, plan });
        return { content: [{ type: "text", text: JSON.stringify(plan, null, 2) }] };
      }
    }), { name: "agent_mesh_plan_mesh_v1_dispatch" });

    api.logger.info(`agent-mesh-wrapper: loaded in ${cfg.mode} mode, dryRun=${cfg.dryRun}`);
  }
});
