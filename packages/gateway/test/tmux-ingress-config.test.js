import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "./ts-extension-resolver.mjs";

const { readRuntimeConfig } = await import("../src/mcp/serve.ts");

const AGENT = {
  id: "agent.ingress.codex",
  name: "Dedicated Codex ingress",
  role: "mcp_ingress",
  status: "online",
  phase_1_active: true,
  capabilities: ["submit_request"],
  enabled_contexts: ["workspace.example"],
  provider: "codex"
};

const CONTEXT = {
  id: "workspace.example",
  type: "workspace",
  name: "Example Workspace",
  parent_id: null,
  owner_human: "Joseph",
  policy_profile: "private",
  status: "active"
};

const BINDING = {
  kind: "user",
  selector: "someone@example.com",
  allowedTools: ["mesh_list_agents", "mesh_send", "mesh_delivery_status"],
  allowedAgentIds: ["agent.ingress.codex"],
  allowedWorkspaceIds: ["workspace.example"],
  allowedDomainIds: []
};

async function writeConfig(extra) {
  const dir = await mkdtemp(join(tmpdir(), "mcp-runtime-"));
  const path = join(dir, "runtime.json");
  await writeFile(
    path,
    JSON.stringify({
      stateDir: "/var/lib/agent-mesh-mcp",
      agents: [AGENT],
      contexts: [CONTEXT],
      bindings: [BINDING],
      ...extra
    })
  );
  return path;
}

const ROUTE = {
  agentSendPath: "/opt/mesh/agent-send.sh",
  agentType: "codex",
  routes: [{ target_agent_id: "agent.ingress.codex", tmux_target: "mesh-codex-ingress" }]
};

test("runtime config still parses without a tmux ingress block", async () => {
  const config = await readRuntimeConfig(await writeConfig({}));
  assert.equal(config.tmuxIngress, undefined);
});

test("tmux ingress routes keep both delivery gates closed unless declared", async () => {
  const config = await readRuntimeConfig(await writeConfig({ tmuxIngress: ROUTE }));
  const [route] = config.tmuxIngress.routes;
  assert.equal(route.enable_real_send, undefined);
  assert.equal(route.allow_mcp_ingress, undefined);
});

test("a route may not target an agent the config never declares", async () => {
  const path = await writeConfig({
    tmuxIngress: {
      ...ROUTE,
      routes: [{ target_agent_id: "agent.typo", tmux_target: "mesh-codex-ingress" }]
    }
  });
  await assert.rejects(readRuntimeConfig(path), /Unknown tmux ingress route target/);
});

test("tmux ingress rejects an unsupported agent type", async () => {
  const path = await writeConfig({ tmuxIngress: { ...ROUTE, agentType: "bash" } });
  await assert.rejects(readRuntimeConfig(path), /Invalid tmux ingress agentType/);
});

test("tmux ingress requires an absolute agent-send path", async () => {
  const path = await writeConfig({ tmuxIngress: { ...ROUTE, agentSendPath: "agent-send.sh" } });
  await assert.rejects(readRuntimeConfig(path), /Invalid tmux ingress agentSendPath/);
});

const AGENT_SESSIONS = {
  agentSessionPath: "/opt/mesh/agent-session.sh",
  agentSendPath: "/opt/mesh/agent-send.sh",
  agentNativeCallPath: "/opt/mesh/agent-native-call.mjs",
  providers: [{
    target_agent_id: "agent.ingress.codex",
    agent_type: "codex",
    workspace_roots: { "workspace.example": ["/srv/workspaces/example"] }
  }]
};

test("runtime config accepts a workspace-scoped Codex session provider", async () => {
  const config = await readRuntimeConfig(await writeConfig({ agentSessions: AGENT_SESSIONS }));
  assert.equal(config.agentSessions.providers[0].agent_type, "codex");
  assert.deepEqual(
    config.agentSessions.providers[0].workspace_roots["workspace.example"],
    ["/srv/workspaces/example"]
  );
});

test("session native call path must be absolute when configured", async () => {
  const path = await writeConfig({
    agentSessions: { ...AGENT_SESSIONS, agentNativeCallPath: "agent-native-call.mjs" }
  });
  await assert.rejects(readRuntimeConfig(path), /Invalid agent sessions agentNativeCallPath/);
});

test("session providers must match the declared agent provider", async () => {
  const path = await writeConfig({
    agentSessions: {
      ...AGENT_SESSIONS,
      providers: [{ ...AGENT_SESSIONS.providers[0], agent_type: "claude" }]
    }
  });
  await assert.rejects(readRuntimeConfig(path), /Invalid agent sessions provider/);
});

test("session provider workspace roots must be absolute", async () => {
  const path = await writeConfig({
    agentSessions: {
      ...AGENT_SESSIONS,
      providers: [{
        ...AGENT_SESSIONS.providers[0],
        workspace_roots: { "workspace.example": ["relative/project"] }
      }]
    }
  });
  await assert.rejects(readRuntimeConfig(path), /Invalid agent sessions workspace roots/);
});
