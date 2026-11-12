import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAppServer } from "./fixtures/fake-app-server.mjs";

const session = "22222222-2222-4222-8222-222222222222";
const bridge = fileURLToPath(new URL("../bin/agent-session.sh", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "mesh-goal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "proc"));
  const sessionCwd = join(root, "session project-with-hyphens");
  const project = join(root, ".claude", "projects", "encoded-project");
  const transcript = join(project, `${session}.jsonl`);
  await mkdir(sessionCwd);
  await mkdir(project, { recursive: true });
  await writeFile(transcript, `${JSON.stringify({ type: "user", cwd: sessionCwd })}\n`);
  const executable = async (name, body) => {
    const path = join(root, name);
    await writeFile(path, `#!${process.execPath}\n${body}\n`);
    await chmod(path, 0o755);
  };
  await executable("claude", `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'agents') {
  if (process.env.BAD_INVENTORY) process.exit(1);
  console.log(process.env.CLAUDE_INVENTORY || '[]');
} else {
  fs.writeFileSync(process.env.GOAL_ARGS, JSON.stringify(args));
  fs.writeFileSync(process.env.GOAL_CWD, process.cwd());
  if (process.env.GOAL_HANG) setInterval(() => {}, 1000);
  else { console.log(process.env.GOAL_OUTPUT || 'Goal command completed'); process.exit(Number(process.env.GOAL_EXIT || 0)); }
}
`);
  const env = {
    ...process.env, PATH: `${root}:${process.env.PATH}`, HOME: root,
    CODEX_HOME: join(root, ".codex"), CLAUDE_BIN: join(root, "claude"),
    CLAUDE_CONFIG_DIR: join(root, ".claude"), CLAUDE_SESSION_ROOT: "",
    CODEX_REMOTE_SOCK: join(root, "server.sock"), CODEX_NO_REMOTE: "",
    AGENT_WRITER_PROC_ROOT: join(root, "proc"), GOAL_ARGS: join(root, "args.json"),
    GOAL_CWD: join(root, "cwd.txt"),
    MESH_GRAPH_DISABLE: "1", AGENT_GOAL_TIMEOUT_MS: "3000",
  };
  const run = (agent, action, args = [], extra = {}) => new Promise((resolve) => {
    execFile("bash", [bridge, "--agent", agent, "goal", action, session, ...args],
      { cwd: root, env: { ...env, ...extra }, timeout: 10000 }, (error, stdout, stderr) => {
        resolve({ code: error?.code || 0, stdout, stderr });
      });
  });
  const writer = async (argv, pid = "200") => {
    await mkdir(join(root, "proc", pid));
    await writeFile(join(root, "proc", pid, "cmdline"), `${argv.join("\0")}\0`);
  };
  return { root, env, run, writer, sessionCwd, transcript };
}

for (const action of ["set", "get", "clear"]) {
  test(`Codex ${action} initializes and resumes before goal RPC`, async (t) => {
    const f = await fixture(t);
    const requests = [];
    const result = action === "clear" ? { cleared: true } : { goal: { objective: "Ship it", status: "active" } };
    const server = createAppServer((message, peer) => {
      requests.push(message);
      if (message.id) {
        peer.send({ method: "thread/status/changed", params: {} });
        peer.send({ id: message.id, result: message.method === `thread/goal/${action}` ? result : {} });
      }
    });
    await new Promise((resolve) => server.listen(f.env.CODEX_REMOTE_SOCK, resolve));
    t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }));
    const args = action === "set" ? ["--objective", "Ship it", "--token-budget", "123"] : [];
    const response = await f.run("codex", action, [...args, "--json"]);
    assert.equal(response.code, 0, response.stderr);
    assert.deepEqual(JSON.parse(response.stdout), result);
    assert.deepEqual(requests.map((request) => request.method), ["initialize", "initialized", "thread/resume", `thread/goal/${action}`]);
    assert.equal(requests[0].params.capabilities.experimentalApi, true);
    assert.deepEqual(requests[2].params, { threadId: session });
    assert.deepEqual(requests[3].params, action === "set"
      ? { threadId: session, objective: "Ship it", status: "active", origin: "user", tokenBudget: 123 }
      : { threadId: session, ...(action === "clear" ? { origin: "user" } : {}) });
  });
}

test("Codex set omits an unspecified token budget and stops on resume errors", async (t) => {
  const f = await fixture(t);
  const requests = [];
  const server = createAppServer((message, peer) => {
    requests.push(message);
    if (!message.id) return;
    peer.send({ id: message.id, ...(processResumeError
      && message.method === "thread/resume" ? { error: { code: -1, message: "resume denied" } } : { result: {} }) });
  });
  let processResumeError = false;
  await new Promise((resolve) => server.listen(f.env.CODEX_REMOTE_SOCK, resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }));
  const response = await f.run("codex", "set", ["--objective", "Ship it"]);
  assert.equal(response.code, 0, response.stderr);
  assert.equal(Object.hasOwn(requests.at(-1).params, "tokenBudget"), false);
  requests.length = 0;
  processResumeError = true;
  const denied = await f.run("codex", "clear");
  assert.notEqual(denied.code, 0);
  assert.match(denied.stderr, /resume denied/);
  assert.equal(requests.some((request) => request.method === "thread/goal/clear"), false);
});

test("invalid goals fail before provider execution", async (t) => {
  const f = await fixture(t);
  for (const budget of ["0", "-1", "1.5", "abc", "1e3", "9007199254740992"]) {
    const response = await f.run("codex", "set", ["--objective", "Ship it", `--token-budget=${budget}`]);
    assert.notEqual(response.code, 0);
    assert.match(response.stderr, /positive safe integer/);
  }
  for (const args of [[], ["--objective", "   "]]) {
    const response = await f.run("codex", "set", args);
    assert.notEqual(response.code, 0);
    assert.match(response.stderr, /requires --objective/);
  }
  const response = await f.run("codex", "get", ["--objective", "ignored"]);
  assert.match(response.stderr, /only supported with set/);
});

for (const kind of ["interactive", "remote-control"]) {
  test(`Claude refuses a live ${kind} writer without resuming`, async (t) => {
    const f = await fixture(t);
    if (kind === "interactive") await f.writer(["claude", "--resume", session]);
    else await f.writer([join(f.root, ".claude/remote/ccd-cli/claude"), "--remote-control"]);
    for (const action of ["set", "clear"]) {
      const response = await f.run("claude", action, action === "set" ? ["--objective", "Ship it"] : [], {
        CLAUDE_INVENTORY: kind === "remote-control" ? JSON.stringify([{ pid: 200, sessionId: session }]) : "[]",
      });
      assert.notEqual(response.code, 0);
      assert.match(response.stderr, /live writer/);
      await assert.rejects(readFile(f.env.GOAL_ARGS), { code: "ENOENT" });
    }
  });
}

test("Claude refuses unknown ownership, a clear alias and token budget", async (t) => {
  const f = await fixture(t);
  for (const [action, args, extra, error] of [
    ["set", ["--objective", "Ship it"], { BAD_INVENTORY: "1" }, /ownership is unknown/],
    ["set", ["--objective", "Ship it", "--token-budget", "1"], {}, /unsupported for claude/],
    ["set", ["--objective", "clear"], {}, /clear alias/],
  ]) {
    const response = await f.run("claude", action, args, extra);
    assert.notEqual(response.code, 0);
    assert.match(response.stderr, error);
    await assert.rejects(readFile(f.env.GOAL_ARGS), { code: "ENOENT" });
  }
});

for (const action of ["set", "clear"]) {
  test(`Claude stopped-session ${action} uses the session cwd instead of the caller cwd`, async (t) => {
    const f = await fixture(t);
    const objective = 'Tests pass; preserve "quoted" text and $HOME';
    const response = await f.run("claude", action, ["--json", ...(action === "set" ? ["--objective", objective] : [])]);
    assert.equal(response.code, 0, response.stderr);
    assert.notEqual(f.root, f.sessionCwd);
    assert.equal(await readFile(f.env.GOAL_CWD, "utf8"), f.sessionCwd);
    assert.deepEqual(JSON.parse(await readFile(f.env.GOAL_ARGS, "utf8")), ["-p", "--resume", session, action === "set" ? `/goal ${objective}` : "/goal clear"]);
    assert.equal(JSON.parse(response.stdout).status, "run_completed");
    assert.equal(JSON.parse(response.stdout).goalStateVerified, false);
  });
}

test("Claude refuses unresolved or invalid session cwd without resuming", async (t) => {
  for (const scenario of ["missing transcript", "missing cwd", "relative cwd", "missing directory", "file cwd", "malformed transcript", "ambiguous transcript"]) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t);
      if (scenario === "missing transcript") await rm(f.transcript);
      if (scenario === "missing cwd") await writeFile(f.transcript, '{}\n');
      if (scenario === "relative cwd") await writeFile(f.transcript, '{"cwd":"relative"}\n');
      if (scenario === "missing directory") await rm(f.sessionCwd, { recursive: true });
      if (scenario === "file cwd") {
        await rm(f.sessionCwd, { recursive: true });
        await writeFile(f.sessionCwd, "not a directory");
      }
      if (scenario === "malformed transcript") await writeFile(f.transcript, 'invalid json\n');
      if (scenario === "ambiguous transcript") {
        const other = join(f.root, ".claude", "projects", "other-project");
        await mkdir(other);
        await writeFile(join(other, `${session}.jsonl`), await readFile(f.transcript));
      }
      for (const action of ["set", "clear"]) {
        const response = await f.run("claude", action, action === "set" ? ["--objective", "Ship it"] : []);
        assert.notEqual(response.code, 0);
        assert.match(response.stderr, /cannot resolve Claude session .* cwd:.*refusing goal run/);
        await assert.rejects(readFile(f.env.GOAL_ARGS), { code: "ENOENT" });
      }
    });
  }
});

test("Claude timeout and provider rejection do not report success", async (t) => {
  const f = await fixture(t);
  const timeout = await f.run("claude", "clear", [], { GOAL_HANG: "1", AGENT_GOAL_TIMEOUT_MS: "200" });
  assert.equal(timeout.code, 124, timeout.stderr);
  assert.match(timeout.stderr, /outcome unknown/);
  const failed = await f.run("claude", "clear", [], { GOAL_EXIT: "2" });
  assert.notEqual(failed.code, 0);
  const rejected = await f.run("claude", "clear", [], { GOAL_OUTPUT: "Unknown command: goal" });
  assert.notEqual(rejected.code, 0);
});
