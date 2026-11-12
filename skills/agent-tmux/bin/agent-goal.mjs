#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { goalCommand, liveClaudeSessions, readClaudeGoal, typeClaudeGoal } from "./claude-goal.mjs";
import { inspectClaudeSessionOwnership } from "./claude-session-ownership.mjs";
import { withCodexAppServer } from "./codex-app-server.mjs";

try {
  const { values, positionals } = parseArgs({
    options: {
      agent: { type: "string" },
      objective: { type: "string" },
      "token-budget": { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const [action, sessionId] = positionals;
  if (!["codex", "claude"].includes(values.agent)) throw new Error("--agent must be codex or claude");
  if (positionals.length !== 2 || !["set", "get", "clear"].includes(action)) {
    throw new Error("expected goal set|get|clear <SESSION_ID>");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new Error("SESSION_ID must be a complete UUID");
  }
  if (action === "set" && !values.objective?.trim()) throw new Error("set requires --objective TEXT");
  if (action !== "set" && (values.objective !== undefined || values["token-budget"] !== undefined)) {
    throw new Error("--objective and --token-budget are only supported with set");
  }
  const budget = values["token-budget"];
  if (budget !== undefined && (!/^[0-9]+$/.test(budget) || !Number.isSafeInteger(Number(budget)) || Number(budget) <= 0)) {
    throw new Error("--token-budget must be a positive safe integer");
  }
  const timeout = Number(process.env.AGENT_GOAL_TIMEOUT_MS || 30000);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600000) {
    throw new Error("AGENT_GOAL_TIMEOUT_MS must be an integer from 1 to 600000");
  }
  const result = values.agent === "codex"
    ? await codexGoal(action, sessionId, values.objective, budget, timeout)
    : await claudeGoal(action, sessionId, values.objective, budget, timeout);
  console.log(values.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`agent-goal: ${error.message}`);
  process.exitCode = error.exitCode || 1;
}

async function codexGoal(action, threadId, objective, budget, timeout) {
  return withCodexAppServer({
    clientName: "agent-mesh-goal",
    timeout,
    timeoutMessage: "app-server goal call timed out; outcome unknown; inspect before retrying",
  }, async (request) => {
    await request("thread/resume", { threadId });
    const params = { threadId };
    if (action === "set") {
      Object.assign(params, { objective, status: "active", origin: "user" });
      if (budget !== undefined) params.tokenBudget = Number(budget);
    }
    if (action === "clear") params.origin = "user";
    return await request(`thread/goal/${action}`, params);
  });
}

async function claudeSessionCwd(sessionId) {
  try {
    const root = process.env.CLAUDE_SESSION_ROOT
      || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
    const transcripts = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name, `${sessionId}.jsonl`);
      try {
        if ((await stat(path)).isFile()) transcripts.push(path);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    if (transcripts.length !== 1) throw new Error("expected exactly one session transcript");
    const input = createReadStream(transcripts[0]);
    const lines = createInterface({ input, crlfDelay: Infinity });
    let cwd;
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const record = JSON.parse(line);
        if (record && Object.hasOwn(record, "cwd")) {
          cwd = record.cwd;
          break;
        }
      }
    } finally {
      lines.close();
      input.destroy();
    }
    if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new Error("transcript has no absolute cwd");
    if (!(await stat(cwd)).isDirectory()) throw new Error("cwd is not a directory");
    return await realpath(cwd);
  } catch (error) {
    throw new Error(`cannot resolve Claude session ${sessionId} cwd: ${error.message}; refusing goal run`);
  }
}

async function claudeGoal(action, sessionId, objective, budget, timeout) {
  if (budget !== undefined) throw new Error("--token-budget is unsupported for claude");
  if (action === "get") return { agent: "claude", sessionId, ...readClaudeGoal(sessionId) };
  if (action === "set" && /^(clear|stop|off|reset|none|cancel)$/i.test(objective.trim())) {
    throw new Error("objective is a Claude /goal clear alias; use goal clear explicitly");
  }
  const live = liveClaudeSessions().get(sessionId);
  if (live) return await typeClaudeGoal(live, goalCommand(action, objective), timeout);
  const cwd = await claudeSessionCwd(sessionId);
  const ownership = inspectClaudeSessionOwnership(sessionId);
  if (ownership.state !== "free") {
    throw new Error(ownership.state === "owned"
      ? `Claude session ${sessionId} has a live writer; refusing goal ${action}`
      : `Claude session ${sessionId} ownership is unknown; refusing goal ${action}`);
  }
  const args = ["-p", "--resume", sessionId, action === "clear" ? "/goal clear" : `/goal ${objective}`];
  return await new Promise((resolve, reject) => {
    const child = spawn(process.env.CLAUDE_BIN || "claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Object.assign(new Error("Claude goal run timed out; outcome unknown; inspect before retrying"), { exitCode: 124 }));
    }, timeout);
    child.stdout.on("data", (data) => { output = (output + data).slice(-65536); });
    child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-4096); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Claude goal run failed (${code}): ${stderr.trim()}`));
      if (/unknown (?:slash )?command|goal.*(?:unavailable|disabled)|error:/i.test(output)) {
        return reject(new Error(`Claude did not accept /goal: ${output.trim()}`));
      }
      resolve({ agent: "claude", sessionId, action, status: "run_completed", output: output.trim(), goalStateVerified: false });
    });
  });
}
