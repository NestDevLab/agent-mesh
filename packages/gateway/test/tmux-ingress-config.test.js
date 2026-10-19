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

test("managed Claude inbox root must be absolute when configured", async () => {
  const path = await writeConfig({
    agentSessions: { ...AGENT_SESSIONS, agentManagedInboxRoot: "managed-inboxes" }
  });
  await assert.rejects(readRuntimeConfig(path), /Invalid agent sessions agentManagedInboxRoot/);
});

test("memory recall legacy and operator-complete profiles are mutually exclusive", async () => {
  const path = await writeConfig({ memoryRecall: {
    command: "/usr/bin/node", script: "/opt/amf/interactive-mcp.mjs", handoffDir: "/run/amf/codex",
    governedWrite: true, operatorComplete: true
  } });
  await assert.rejects(readRuntimeConfig(path), /mutually exclusive/);
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

const CLAUDE_AGENT = { ...AGENT, id: "agent.ingress.claude", name: "Dedicated Claude ingress", provider: "claude" };
const CLAUDE_BINDING = { ...BINDING, allowedAgentIds: ["agent.ingress.claude"] };
const CLAUDE_SESSIONS = {
  ...AGENT_SESSIONS,
  providers: [{
    target_agent_id: "agent.ingress.claude",
    agent_type: "claude",
    workspace_roots: { "workspace.example": ["/srv/workspaces/example"] },
    fresh_session: { workspace_cwd: { "workspace.example": "/srv/workspaces/example/fresh" } }
  }]
};

test("runtime config accepts an opt-in Claude fresh-session directory", async () => {
  const config = await readRuntimeConfig(await writeConfig({ agents: [CLAUDE_AGENT], bindings: [CLAUDE_BINDING], agentSessions: CLAUDE_SESSIONS }));
  assert.deepEqual(config.agentSessions.providers[0].fresh_session.workspace_cwd, {
    "workspace.example": "/srv/workspaces/example/fresh"
  });
});

test("Codex create-session profiles are explicit and unknown values fail closed", async () => {
  const codex = await writeConfig({
    agentSessions: {
      ...AGENT_SESSIONS,
      providers: [{ ...AGENT_SESSIONS.providers[0], fresh_session: {
        ...CLAUDE_SESSIONS.providers[0].fresh_session,
        access_profiles: ["read-only", "full-access"], full_access_socket: "mesh-host"
      } }]
    }
  });
  assert.deepEqual((await readRuntimeConfig(codex)).agentSessions.providers[0].fresh_session.access_profiles,
    ["read-only", "full-access"]);
  const invalid = await writeConfig({ agentSessions: { ...AGENT_SESSIONS, providers: [{
    ...AGENT_SESSIONS.providers[0], fresh_session: {
      ...CLAUDE_SESSIONS.providers[0].fresh_session, access_profiles: ["root"]
    }
  }] } });
  await assert.rejects(readRuntimeConfig(invalid), /Invalid agent sessions access profiles/);
  const missingSocket = await writeConfig({ agentSessions: { ...AGENT_SESSIONS, providers: [{
    ...AGENT_SESSIONS.providers[0], fresh_session: {
      ...CLAUDE_SESSIONS.providers[0].fresh_session, access_profiles: ["read-only", "full-access"]
    }
  }] } });
  await assert.rejects(readRuntimeConfig(missingSocket), /requires a trusted host tmux socket/);
});

test("fresh session directories reject unconfigured workspaces", async () => {

  const unknownWorkspace = await writeConfig({
    agents: [CLAUDE_AGENT],
    bindings: [CLAUDE_BINDING],
    agentSessions: {
      ...CLAUDE_SESSIONS,
      providers: [{ ...CLAUDE_SESSIONS.providers[0], fresh_session: { workspace_cwd: { "workspace.other": "/srv/other" } } }]
    }
  });
  await assert.rejects(readRuntimeConfig(unknownWorkspace), /fresh_session workspace at index 0: workspace.other/);

  const relative = await writeConfig({
    agents: [CLAUDE_AGENT],
    bindings: [CLAUDE_BINDING],
    agentSessions: {
      ...CLAUDE_SESSIONS,
      providers: [{ ...CLAUDE_SESSIONS.providers[0], fresh_session: { workspace_cwd: { "workspace.example": "fresh" } } }]
    }
  });
  await assert.rejects(readRuntimeConfig(relative), /fresh_session workspace at index 0/);

  const outsideRoots = await writeConfig({
    agents: [CLAUDE_AGENT],
    bindings: [CLAUDE_BINDING],
    agentSessions: {
      ...CLAUDE_SESSIONS,
      providers: [{ ...CLAUDE_SESSIONS.providers[0], fresh_session: { workspace_cwd: { "workspace.example": "/srv/workspaces/elsewhere" } } }]
    }
  });
  await assert.rejects(readRuntimeConfig(outsideRoots), /fresh_session directory is outside the workspace roots at index 0/);
});

const WORKER_ROUTE = {
  id: "worker.example", principalId: "principal.example", agentId: "agent.ingress.codex",
  workspaceId: "workspace.example", accessMode: "workspace-write", socketPath: "/srv/control/worker.sock"
};
test("runtime config retains explicit worker routes and rejects unknown scopes and duplicate grants", async () => {
  const config = await readRuntimeConfig(await writeConfig({ workspaceWorkers: [WORKER_ROUTE] }));
  assert.deepEqual(config.workspaceWorkers, [WORKER_ROUTE]);
  for (const routes of [[{ ...WORKER_ROUTE, agentId: "agent.unknown" }], [{ ...WORKER_ROUTE, workspaceId: "workspace.unknown" }], [WORKER_ROUTE, WORKER_ROUTE], [{ ...WORKER_ROUTE, principalId: "*" }]]) {
    await assert.rejects(readRuntimeConfig(await writeConfig({ workspaceWorkers: routes })), /workspace worker|Duplicate|Invalid/);
  }
});

test("Codex fresh task_sessions opt-in is wired and rejects nonboolean values and Claude", async () => {
  const provider = { ...AGENT_SESSIONS.providers[0], fresh_session: { workspace_cwd: { "workspace.example": "/srv/workspaces/example" }, task_sessions: true } };
  const config = await readRuntimeConfig(await writeConfig({ agentSessions: { ...AGENT_SESSIONS, providers: [provider] } }));
  assert.equal(config.agentSessions.providers[0].fresh_session.task_sessions, true);
  await assert.rejects(readRuntimeConfig(await writeConfig({ agentSessions: { ...AGENT_SESSIONS, providers: [{ ...provider, fresh_session: { ...provider.fresh_session, task_sessions: "yes" } }] } })), /task_sessions/);
  await assert.rejects(readRuntimeConfig(await writeConfig({ agents: [CLAUDE_AGENT], bindings: [{ ...BINDING, allowedAgentIds: [CLAUDE_AGENT.id] }], agentSessions: { ...AGENT_SESSIONS, providers: [{ ...provider, target_agent_id: CLAUDE_AGENT.id, agent_type: "claude" }] } })), /task_sessions/);
});
