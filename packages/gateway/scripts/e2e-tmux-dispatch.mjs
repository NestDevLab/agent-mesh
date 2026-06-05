#!/usr/bin/env node
// End-to-end: submit an envelope through the REAL GatewayService, with the tmux
// transport registered as an active peer, routed to a live Codex tmux session.
//
//   node scripts/e2e-tmux-dispatch.mjs
//
// Env:
//   E2E_TMUX_TARGET   tmux session name of the target agent (default mesh-codex-019e8d58)
//   MESH_TMUX_SOCKET  dedicated tmux socket (default "mesh")
//   E2E_STAMP         unique suffix for ids (default from Date.now)

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve .js imports to .ts (same trick the test suite uses).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      specifier.endsWith(".js")
    ) {
      const tsSpecifier = `${specifier.slice(0, -3)}.ts`;
      const candidate = new URL(tsSpecifier, new URL(context.parentURL));
      if (existsSync(candidate)) return nextResolve(tsSpecifier, context);
    }
    return nextResolve(specifier, context);
  }
});

const here = path.dirname(fileURLToPath(import.meta.url));
const gatewayRoot = path.resolve(here, "..");
const repoRoot = path.resolve(gatewayRoot, "../..");
const agentSendPath = path.join(repoRoot, "packages/tmux-bridge/bin/agent-send.sh");

const { GatewayService } = await import("../src/core/gateway-service.js");
const { TmuxTransportAdapter } = await import("../src/adapters/tmux-transport-adapter.js");
const { ShellTmuxSender } = await import("../src/adapters/shell-tmux-sender.js");
const { SimulatedAgentAdapter } = await import("../src/adapters/simulated-agent-adapter.js");
const { DiscordTranscriptStubAdapter } = await import(
  "../src/adapters/discord-transcript-stub-adapter.js"
);
const { AgentRegistry } = await import("../src/core/agent-registry.js");
const { ContextRegistry } = await import("../src/core/context-registry.js");

const stamp = process.env.E2E_STAMP ?? String(Date.now());
const tmuxTarget = process.env.E2E_TMUX_TARGET ?? "mesh-codex-019e8d58";
const meshSocket = process.env.MESH_TMUX_SOCKET ?? "mesh";
const stateDir = path.join(repoRoot, "var", "e2e-tmux", stamp);

const sender = new ShellTmuxSender({
  agentSendPath,
  agentType: "codex",
  timeoutSeconds: 120,
  meshSocket
});

const tmuxAdapter = new TmuxTransportAdapter({
  sender,
  routes: [
    {
      target_agent_id: "agent.software_engineer",
      tmux_target: tmuxTarget,
      enable_real_send: true
    }
  ],
  stateDir
});

const agentRegistry = await AgentRegistry.fromFile(
  path.join(gatewayRoot, "config", "agents.json")
);
const contextRegistry = await ContextRegistry.fromFile(
  path.join(gatewayRoot, "config", "contexts.json")
);

const gateway = await GatewayService.create({
  adapters: [new SimulatedAgentAdapter(), new DiscordTranscriptStubAdapter(), tmuxAdapter],
  agentRegistry,
  contextRegistry,
  stateDir
});

const envelope = {
  schema: "openclaw.agent.message.v1",
  message_id: `e2e-msg-${stamp}`,
  created_at: new Date().toISOString(),
  workspace_id: "workspace.the operator",
  domain_id: "domain.nestdev",
  conversation_id: `e2e-conv-${stamp}`,
  from: "agent.chief_of_staff",
  to: "agent.software_engineer",
  intent: "request",
  ttl: 5,
  hop_count: 0,
  idempotency_key: `e2e-idem-${stamp}`,
  content: {
    text:
      "MESH E2E PING from Claude via the gateway tmux transport. " +
      "Reply in ONE short line: confirm receipt and state today's date."
  },
  trace_id: `e2e-trace-${stamp}`,
  correlation_id: `e2e-corr-${stamp}`
};

console.log("=== E2E: submitEnvelope through GatewayService ===");
console.log("state dir :", stateDir);
console.log("tmux target:", `${meshSocket}:${tmuxTarget}`);
console.log("envelope   :", envelope.message_id, "->", envelope.to);

const result = await gateway.submitEnvelope(envelope);

console.log("\n=== Delivery records (one per active transport) ===");
for (const d of result.deliveries) {
  console.log(`  ${d.adapter_id.padEnd(22)} status=${d.status} attempts=${d.attempts}`);
}

const auditPath = path.join(stateDir, "tmux-dispatch-events.ndjson");
console.log("\n=== tmux-dispatch-events.ndjson (mesh-side audit) ===");
const raw = await readFile(auditPath, "utf8").catch(() => "");
for (const line of raw.split("\n").filter(Boolean)) {
  const ev = JSON.parse(line);
  const d = ev.data;
  console.log(
    `  ${d.status.padEnd(9)} sender_called=${d.sender_called} target=${d.tmux_target} reason=${d.reason}`
  );
}
console.log("\n(Observe the Codex side: tmux -L", meshSocket, "attach -t", tmuxTarget + ")");
console.log("=== E2E complete ===");
