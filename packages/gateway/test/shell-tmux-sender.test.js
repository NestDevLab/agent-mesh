import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const { ShellTmuxSender } = await import(
  "../src/adapters/shell-tmux-sender.js"
);

const baseInput = {
  target_agent_id: "agent.software_engineer",
  tmux_target: "mesh-codex-main",
  prompt: "ping",
  message_id: "m1",
  context_id: "context-1",
  task_id: "task-1",
  correlation_id: "task-1",
  idempotency_key: "k1"
};

test("builds the agent-send.sh invocation and maps exit 0 to ok:true", async () => {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { code: 0, stdout: "pong\n", stderr: "" };
  };
  const sender = new ShellTmuxSender({
    agentSendPath: "/x/agent-send.sh",
    agentType: "codex",
    timeoutSeconds: 90,
    meshSocket: "mesh",
    run
  });

  const res = await sender.send(baseInput);

  assert.equal(res.ok, true);
  assert.equal(res.reply, "pong");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "/x/agent-send.sh");
  assert.deepEqual(calls[0].args, [
    "--agent",
    "codex",
    "--correlation-id",
    "task-1",
    "--result-token",
    createHash("sha256").update("task-1").digest("hex").slice(0, 16),
    "mesh-codex-main",
    "ping",
    "90"
  ]);
  assert.equal(calls[0].opts.env.MESH_TMUX_SOCKET, "mesh");
});

test("maps a non-zero exit to ok:false with stderr as the error", async () => {
  const run = async () => ({ code: 124, stdout: "", stderr: "STALLED: no final reply" });
  const sender = new ShellTmuxSender({
    agentSendPath: "/x/agent-send.sh",
    agentType: "codex",
    run
  });

  const res = await sender.send(baseInput);

  assert.equal(res.ok, true);
  assert.equal(res.result_error_code, "result_timeout");
  assert.match(res.error, /STALLED/);
});

test("keeps delivered transport separate from result collection failures", async () => {
  for (const [exitCode, expected] of [
    [4, "result_timeout"],
    [65, "result_no_output"],
    [66, "result_uncorrelated"],
    [67, "result_parsing_failure"],
    [124, "result_timeout"]
  ]) {
    const sender = new ShellTmuxSender({
      agentSendPath: "/x/agent-send.sh",
      agentType: "codex",
      run: async () => ({ code: exitCode, stdout: "", stderr: `exit ${exitCode}` })
    });
    assert.deepEqual(await sender.send(baseInput), {
      ok: true,
      result_error_code: expected,
      error: `exit ${exitCode}`
    });
  }
});

test("classifies an empty exit-0 reply as no output", async () => {
  const sender = new ShellTmuxSender({
    agentSendPath: "/x/agent-send.sh",
    agentType: "codex",
    run: async () => ({ code: 0, stdout: "\n", stderr: "" })
  });
  assert.equal((await sender.send(baseInput)).result_error_code, "result_no_output");
});

test("maps a spawn rejection to ok:false", async () => {
  const run = async () => {
    throw new Error("ENOENT agent-send.sh");
  };
  const sender = new ShellTmuxSender({
    agentSendPath: "/missing/agent-send.sh",
    agentType: "codex",
    run
  });

  const res = await sender.send(baseInput);

  assert.equal(res.ok, false);
  assert.match(res.error, /ENOENT/);
});

test("defaults timeout to 120 and omits MESH_TMUX_SOCKET when unset", async () => {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push({ args, opts });
    return { code: 0, stdout: "ok", stderr: "" };
  };
  const sender = new ShellTmuxSender({
    agentSendPath: "/x/agent-send.sh",
    agentType: "claude",
    run
  });

  await sender.send(baseInput);

  assert.equal(calls[0].args[0], "--agent");
  assert.equal(calls[0].args[1], "claude");
  assert.equal(calls[0].args.at(-1), "120");
  assert.equal(calls[0].opts.env.MESH_TMUX_SOCKET, undefined);
});
