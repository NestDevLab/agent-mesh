import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  hasDiscordMention,
  hydrateCcMeshMessage,
  loadParticipantRegistry,
  matchesLocalParticipant,
  parseCcMeshRecipients
} from "../src/core.js";

function textFrom(event = {}, ctx = {}) {
  for (const value of [
    event.content,
    event.text,
    event.body,
    event.message,
    ctx.content,
    ctx.text,
    ctx.Body,
    ctx.RawBody,
    ctx.BodyForAgent
  ]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function localLabelsFrom(cfg = {}, ctx = {}) {
  const labels = new Set(cfg.localLabels || []);
  for (const value of [cfg.localLabel, ctx.agentId]) {
    if (typeof value === "string" && value.trim()) labels.add(value.trim());
  }
  return [...labels];
}

function markAddressed(ctx = {}, source = "cc-mesh") {
  if (!ctx || typeof ctx !== "object") return;
  ctx.WasMentioned = true;
  ctx.wasMentioned = true;
  ctx.ExplicitlyMentionedBot = true;
  ctx.MentionSource = source;
  const guidance = "cc-mesh addressed this agent through semantic routing. Treat the message as addressed to you, but keep using the mesh-discord-routing skill for any routed reply.";
  ctx.GroupSystemPrompt = ctx.GroupSystemPrompt ? `${ctx.GroupSystemPrompt}\n\n${guidance}` : guidance;
}

function normalizeConfig(raw = {}) {
  return {
    enabled: raw.enabled !== false,
    hydrateOutbound: raw.hydrateOutbound !== false,
    outboundFailurePolicy: ["block", "warn"].includes(raw.outboundFailurePolicy) ? raw.outboundFailurePolicy : "block",
    addressInbound: raw.addressInbound !== false,
    configPath: raw.configPath,
    localLabel: raw.localLabel,
    localLabels: Array.isArray(raw.localLabels) ? raw.localLabels : []
  };
}

export default definePluginEntry({
  id: "mesh-discord-routing",
  name: "Mesh Discord Routing",
  description: "OpenClaw support plugin for the portable cc-mesh Discord routing skill.",
  register(api) {
    const cfg = normalizeConfig(api.pluginConfig || {});
    if (!cfg.enabled) {
      api.logger.info("mesh-discord-routing: disabled");
      return;
    }

    const registry = () => loadParticipantRegistry({ configPath: cfg.configPath });

    const maybeAddress = (event = {}, ctx = {}) => {
      if (!cfg.addressInbound) return;
      const text = textFrom(event, ctx);
      if (parseCcMeshRecipients(text).length === 0) return;
      const { participants } = registry();
      if (!matchesLocalParticipant(text, localLabelsFrom(cfg, ctx), participants)) return;
      event.wasMentioned = true;
      markAddressed(ctx);
      api.logger.info(`mesh-discord-routing: marked cc-mesh message as addressed for ${ctx.agentId || cfg.localLabel || "agent"}`);
    };

    api.on("inbound_claim", maybeAddress);
    api.on("before_dispatch", maybeAddress);

    api.on("message_sending", async (event = {}, ctx = {}) => {
      if (!cfg.hydrateOutbound) return;
      const content = event.content ?? event.text ?? event.message;
      if (typeof content !== "string") return;
      if (parseCcMeshRecipients(content).length === 0 || hasDiscordMention(content)) return;
      try {
        const hydrated = hydrateCcMeshMessage(content, registry().participants);
        api.logger.info(`mesh-discord-routing: hydrated outbound cc-mesh message for ${ctx.sessionKey || ctx.channelId || "unknown"}`);
        return { content: hydrated };
      } catch (err) {
        api.logger.warn(`mesh-discord-routing: outbound hydration failed: ${err.message}`);
        if (cfg.outboundFailurePolicy === "block") {
          return {
            cancel: true,
            cancelReason: "mesh_hydration_failed",
            metadata: {
              code: err.code || "HYDRATION_FAILED",
              unknown: Array.isArray(err.unknown) ? err.unknown : undefined
            }
          };
        }
      }
    });
  }
});
