import assert from "node:assert/strict";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const { AgentSessionRegistry, ShellAgentSessionProvider } = await import(
  "../src/adapters/agent-session-provider.ts"
);

const sessions = [
  { session_id: "session-new", agent_type: "codex", cwd: "/workspace/project-a", updated_at: "2026-08-30T12:00:00Z" },
  { session_id: "session-old", agent_type: "codex", cwd: "/workspace/project-b", updated_at: "2026-08-29T12:00:00Z" },
  { session_id: "session-secret", agent_type: "codex", cwd: "/private/other", updated_at: "2026-08-28T12:00:00Z" }
];

function provider(overrides = {}) {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args: [...args], options });
    if (command === "/bridge/agent-session.sh" && args.includes("list")) {
      return { code: 0, stdout: JSON.stringify({ agent_type: "codex", sessions }), stderr: "" };
    }
    if (command === "/bridge/agent-session.sh" && args.includes("inspect")) {
      const session = sessions.find((candidate) => candidate.session_id === args.at(-2));
      return session === undefined
        ? { code: 3, stdout: "", stderr: "not found" }
        : { code: 0, stdout: JSON.stringify({ agent_type: "codex", sessions: [session] }), stderr: "" };
    }
    if (command === "/bridge/agent-session.sh" && args.includes("writer-status")) {
      return {
        code: 0,
        stdout: JSON.stringify({ agent: args[1], sessionId: args.at(-2), writers: [] }),
        stderr: ""
      };
    }
    if (command === "/bridge/agent-session.sh" && args.includes("resume")) {
      return { code: 0, stdout: "mesh-codex-session-new\n", stderr: "" };
    }
    if (command === "/bridge/agent-send.sh") {
      return { code: 0, stdout: "provider result\n", stderr: "" };
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
  const instance = new ShellAgentSessionProvider({
    agentId: "agent.ingress.codex",
    agentType: "codex",
    agentSessionPath: "/bridge/agent-session.sh",
    agentSendPath: "/bridge/agent-send.sh",
    workspaceRoots: { "workspace.allowed": ["/workspace"] },
    run,
    ...overrides
  });
  return { instance, calls };
}

test("session discovery is workspace-scoped, paginated, and path-free", async () => {
  const { instance } = provider();
  const first = await instance.list({ workspaceId: "workspace.allowed", limit: 1 });
  assert.equal(first.sessions.length, 1);
  assert.equal(first.sessions[0].session_id, "session-new");
  assert.equal("cwd" in first.sessions[0], false);
  assert.ok(first.next_cursor);

  const second = await instance.list({
    workspaceId: "workspace.allowed",
    cursor: first.next_cursor,
    limit: 10
  });
  assert.deepEqual(second.sessions.map((session) => session.session_id), ["session-old"]);
  assert.equal(second.next_cursor, null);
});

test("session lookup fails closed outside the authorized workspace", async () => {
  const { instance } = provider();
  assert.equal(await instance.get({ workspaceId: "workspace.allowed", sessionId: "session-secret" }), undefined);
  await assert.rejects(
    instance.list({ workspaceId: "workspace.unknown", limit: 25 }),
    /workspace is not configured/
  );
  await assert.rejects(
    instance.list({ workspaceId: "workspace.allowed", cursor: "bm90LWEtbnVtYmVy", limit: 25 }),
    /Invalid agent session cursor/
  );
});

test("targeted send resumes the exact session then preserves task correlation", async () => {
  const { instance, calls } = provider({ meshSocket: "mesh-session-test" });
  const result = await instance.send({
    sessionId: "session-new",
    workspaceId: "workspace.allowed",
    message: "Return the literal result.",
    messageId: "message-1",
    contextId: "context-1",
    taskId: "task-1",
    correlationId: "task-1",
    idempotencyKey: "idem-1"
  });
  assert.deepEqual(result, { ok: true, reply: "provider result" });
  const resume = calls.find((call) => call.command.endsWith("agent-session.sh") && call.args.includes("resume"));
  assert.deepEqual(resume.args, ["--agent", "codex", "resume", "session-new"]);
  assert.equal(resume.options.env.MESH_TMUX_SOCKET, "mesh-session-test");
  assert.ok(calls.some((call) => call.args.includes("writer-status")));
  const send = calls.find((call) => call.command.endsWith("agent-send.sh"));
  assert.ok(send.args.includes("--correlation-id"));
  assert.ok(send.args.includes("task-1"));
  assert.ok(send.args.includes("mesh-codex-session-new"));
});

test("active Codex sessions use the native queue collector without a second writer", async () => {
  const { instance, calls } = provider({
    agentNativeCallPath: "/bridge/agent-native-call.mjs",
    run: async (command, args) => {
      calls.push({ command, args: [...args] });
      if (command.endsWith("agent-session.sh") && args.includes("inspect")) {
        return { code: 0, stdout: JSON.stringify({ agent_type: "codex", sessions: [sessions[0]] }), stderr: "" };
      }
      if (command.endsWith("agent-session.sh") && args.includes("writer-status")) {
        return { code: 0, stdout: JSON.stringify({ agent: "codex", sessionId: "session-new", writers: [{ pid: 42, kind: "codex" }] }), stderr: "" };
      }
      if (command === process.execPath && args[0] === "/bridge/agent-native-call.mjs") {
        return { code: 0, stdout: "native result\n", stderr: "" };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    }
  });
  const result = await instance.send({
    sessionId: "session-new",
    workspaceId: "workspace.allowed",
    message: "Return a result.",
    messageId: "message-native",
    contextId: "context-native",
    taskId: "task-native",
    correlationId: "task-native",
    idempotencyKey: "idem-native"
  });
  assert.deepEqual(result, { ok: true, reply: "native result" });
  assert.ok(calls.some((call) => call.command === process.execPath && call.args.includes("task-native")));
  assert.equal(calls.some((call) => call.args.includes("resume")), false);
  assert.equal(calls.some((call) => call.command.endsWith("agent-send.sh")), false);
});

test("active Claude sessions fail closed instead of starting a second writer", async () => {
  const claudeSession = { ...sessions[0], agent_type: "claude" };
  const { instance, calls } = provider({
    agentId: "agent.ingress.claude",
    agentType: "claude",
    run: async (command, args) => {
      calls.push({ command, args: [...args] });
      if (args.includes("inspect")) {
        return { code: 0, stdout: JSON.stringify({ agent_type: "claude", sessions: [claudeSession] }), stderr: "" };
      }
      if (args.includes("writer-status")) {
        return { code: 0, stdout: JSON.stringify({ agent: "claude", sessionId: "session-new", writers: [{ pid: 43, kind: "claude-cli" }] }), stderr: "" };
      }
      throw new Error("unexpected command");
    }
  });
  const result = await instance.send({
    sessionId: "session-new", workspaceId: "workspace.allowed", message: "hello",
    messageId: "message", contextId: "context", correlationId: "task", idempotencyKey: "idem"
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /no safe native queue transport/);
  assert.equal(calls.some((call) => call.args.includes("resume")), false);
});

test("registry supports independent Codex and Claude providers", () => {
  const codex = provider().instance;
  const claude = provider({
    agentId: "agent.ingress.claude",
    agentType: "claude"
  }).instance;
  const registry = new AgentSessionRegistry([codex, claude]);
  assert.equal(registry.has("agent.ingress.codex"), true);
  assert.equal(registry.has("agent.ingress.claude"), true);
  assert.equal(codex.provider, "codex");
  assert.equal(claude.provider, "claude");
});

test("concurrent tasks targeting one session are serialized before prompt capture", async () => {
  let activeSends = 0;
  let maxActiveSends = 0;
  const { instance } = provider({
    run: async (command, args) => {
      if (command.endsWith("agent-session.sh") && args.includes("inspect")) {
        return { code: 0, stdout: JSON.stringify({ agent_type: "codex", sessions: [sessions[0]] }), stderr: "" };
      }
      if (command.endsWith("agent-session.sh") && args.includes("resume")) {
        return { code: 0, stdout: "mesh-codex-session-new\n", stderr: "" };
      }
      if (command.endsWith("agent-session.sh") && args.includes("writer-status")) {
        return { code: 0, stdout: JSON.stringify({ agent: "codex", sessionId: "session-new", writers: [] }), stderr: "" };
      }
      if (command.endsWith("agent-send.sh")) {
        activeSends += 1;
        maxActiveSends = Math.max(maxActiveSends, activeSends);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeSends -= 1;
        return { code: 0, stdout: `${args.includes("task-a") ? "A" : "B"}\n`, stderr: "" };
      }
      throw new Error("unexpected command");
    }
  });
  const base = {
    sessionId: "session-new",
    workspaceId: "workspace.allowed",
    message: "result",
    messageId: "message",
    contextId: "context",
    idempotencyKey: "idem"
  };
  const [first, second] = await Promise.all([
    instance.send({ ...base, taskId: "task-a", correlationId: "task-a" }),
    instance.send({ ...base, taskId: "task-b", correlationId: "task-b" })
  ]);
  assert.equal(maxActiveSends, 1);
  assert.deepEqual([first.reply, second.reply], ["A", "B"]);
});
