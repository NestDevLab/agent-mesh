#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { inspectClaudeSessionOwnership } from "./claude-session-ownership.mjs";

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

function codexSocket() {
  if (process.env.CODEX_NO_REMOTE === "1") throw new Error("CODEX_NO_REMOTE disables app-server goal calls");
  if (process.env.CODEX_REMOTE_SOCK !== undefined) {
    if (!process.env.CODEX_REMOTE_SOCK) throw new Error("CODEX_REMOTE_SOCK is empty; no app-server selected");
    return process.env.CODEX_REMOTE_SOCK;
  }
  const listening = spawnSync("ss", ["-lx"], { encoding: "utf8", timeout: 5000 });
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  for (const name of ["desktop-ssh-websocket-v0.sock", "app-server-control.sock"]) {
    const path = join(home, "app-server-control", name);
    if (listening.status === 0 && listening.stdout.includes(path)) return path;
  }
  throw new Error("no listening Codex app-server socket found; set CODEX_REMOTE_SOCK");
}

async function codexGoal(action, threadId, objective, budget, timeout) {
  const child = spawn(process.env.CODEX_BIN || "codex", ["app-server", "proxy", "--sock", codexSocket()], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 0;
  let failure;
  let stderr = "";
  const rejectAll = (error) => {
    failure = error;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-4096); });
  child.on("error", rejectAll);
  child.stdin.on("error", rejectAll);
  child.on("close", (code) => rejectAll(new Error(`app-server proxy closed (${code}): ${stderr.trim()}`)));
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); }
    catch { rejectAll(new Error("invalid JSON from app-server proxy")); return; }
    if (message.method) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`app-server: ${message.error.message || JSON.stringify(message.error)}`));
    else if (Object.hasOwn(message, "result")) waiter.resolve(message.result);
    else waiter.reject(new Error("invalid app-server response"));
  });
  const timer = setTimeout(() => {
    rejectAll(Object.assign(new Error("app-server goal call timed out; outcome unknown; inspect before retrying"), { exitCode: 124 }));
    child.kill("SIGKILL");
  }, timeout);
  const request = (method, params) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  try {
    await request("initialize", {
      clientInfo: { name: "agent-mesh-goal", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    await request("thread/resume", { threadId });
    const params = { threadId };
    if (action === "set") {
      Object.assign(params, { objective, status: "active", origin: "user" });
      if (budget !== undefined) params.tokenBudget = Number(budget);
    }
    if (action === "clear") params.origin = "user";
    return await request(`thread/goal/${action}`, params);
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.destroy();
    child.kill("SIGKILL");
  }
}

async function claudeGoal(action, sessionId, objective, budget, timeout) {
  if (action === "get") throw new Error("get is unsupported for claude; inspect /goal in the owning session");
  if (budget !== undefined) throw new Error("--token-budget is unsupported for claude");
  if (action === "set" && /^(clear|stop|off|reset|none|cancel)$/i.test(objective.trim())) {
    throw new Error("objective is a Claude /goal clear alias; use goal clear explicitly");
  }
  const ownership = inspectClaudeSessionOwnership(sessionId);
  if (ownership.state !== "free") {
    throw new Error(ownership.state === "owned"
      ? `Claude session ${sessionId} has a live writer; refusing goal ${action}`
      : `Claude session ${sessionId} ownership is unknown; refusing goal ${action}`);
  }
  const args = ["-p", "--resume", sessionId, action === "clear" ? "/goal clear" : `/goal ${objective}`];
  return await new Promise((resolve, reject) => {
    const child = spawn(process.env.CLAUDE_BIN || "claude", args, { stdio: ["ignore", "pipe", "pipe"] });
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
