/** Read Claude goal state from transcripts and type /goal into live tmux-hosted sessions. */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const configDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const projectsRoot = () => process.env.CLAUDE_SESSION_ROOT || join(configDir(), "projects");
const procRoot = () => process.env.AGENT_WRITER_PROC_ROOT || "/proc";

export function claudeTranscripts(sessionId) {
  const found = [];
  let entries;
  try { entries = readdirSync(projectsRoot(), { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(projectsRoot(), entry.name, `${sessionId}.jsonl`);
    try {
      const info = statSync(path);
      if (info.isFile()) found.push({ path, mtimeMs: info.mtimeMs });
    } catch { /* not in this project */ }
  }
  return found.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

// Claude writes a goal_status attachment on every set, evaluation and clear. Set and clear carry
// `sentinel: true` (unmet on set, met on clear); evaluations carry the model's verdict.
export function readClaudeGoal(sessionId) {
  let latest;
  for (const { path } of claudeTranscripts(sessionId)) {
    let text;
    try { text = readFileSync(path, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.includes('"goal_status"')) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const goal = record?.attachment;
      if (goal?.type !== "goal_status") continue;
      if (!latest || String(record.timestamp) >= String(latest.timestamp)) latest = { ...goal, timestamp: record.timestamp };
    }
  }
  if (!latest) return { state: "none" };
  const state = latest.sentinel ? (latest.met ? "cleared" : "active") : (latest.met ? "achieved" : "active");
  return {
    state,
    condition: typeof latest.condition === "string" ? latest.condition : "",
    met: latest.met === true,
    ...(latest.reason ? { reason: String(latest.reason) } : {}),
    updatedAt: latest.timestamp,
  };
}

function processStart(pid) {
  try {
    const fields = readFileSync(join(procRoot(), String(pid), "stat"), "utf8").split(")").pop().trim().split(/\s+/);
    return fields[19];
  } catch { return undefined; }
}

/** Registry records of running Claude processes, keyed by session id. */
export function liveClaudeSessions() {
  const sessions = new Map();
  const dir = join(configDir(), "sessions");
  let names;
  try { names = readdirSync(dir); } catch { return sessions; }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let record;
    try { record = JSON.parse(readFileSync(join(dir, name), "utf8")); } catch { continue; }
    if (typeof record?.sessionId !== "string" || !Number.isInteger(record.pid)) continue;
    // A recycled pid keeps the registry file but not the process start time.
    if (record.procStart === undefined || String(record.procStart) !== processStart(record.pid)) continue;
    sessions.set(record.sessionId, record);
  }
  return sessions;
}

export function goalCommand(action, objective) {
  return action === "clear" ? "/goal clear" : `/goal ${objective.replace(/\s+/g, " ").trim()}`;
}

/** Types a /goal command into the session's tmux pane; slash commands sent as messages arrive as plain text. */
export async function typeClaudeGoal(record, command, timeout) {
  if (typeof record.tmux !== "string" || !record.tmux) {
    throw Object.assign(new Error(`Claude session ${record.sessionId} is live outside tmux; type ${command.split(" ")[0]} in that session`), { exitCode: 3 });
  }
  if (record.status === "busy") {
    // An unmet goal keeps the session busy forever, so clear has to interrupt the loop first.
    if (command !== "/goal clear" || !(await interrupt(record, timeout))) {
      throw Object.assign(new Error(`Claude session ${record.sessionId} is busy; retry when it is idle`), { exitCode: 6 });
    }
  }
  const sender = process.env.AGENT_GOAL_SENDER || fileURLToPath(new URL("./agent-send.sh", import.meta.url));
  const started = new Date().toISOString();
  const result = await new Promise((resolve, reject) => {
    const child = spawn("bash", [sender, "--agent", "claude", "--submit-only", "--quiet",
      "--correlation-id", `goal-${randomUUID()}`, record.tmux, command],
      { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Object.assign(new Error("typing /goal timed out; outcome unknown; inspect before retrying"), { exitCode: 124 }));
    }, timeout);
    child.stdout.resume();
    child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-4096); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stderr: stderr.trim() }); });
  });
  const goal = await waitForGoal(record.sessionId, started, Math.min(timeout, result.code === 0 ? 10_000 : 3_000));
  // `/goal clear` runs locally without starting a turn, which agent-send reports as not submitted.
  if (result.code !== 0 && !(goal && (command === "/goal clear") === (goal.state === "cleared"))) {
    throw Object.assign(new Error(`typing /goal into ${record.tmux} failed (${result.code}): ${result.stderr}`), { exitCode: result.code === 4 ? 4 : 6 });
  }
  return {
    agent: "claude", sessionId: record.sessionId, status: "submitted", via: "tmux", target: record.tmux,
    goalStateVerified: Boolean(goal), ...(goal ? { goal } : {}),
  };
}

async function interrupt(record, timeout) {
  const tmux = process.env.AGENT_GOAL_TMUX || "tmux";
  const code = await new Promise((resolve) => {
    const child = spawn(tmux, ["-L", process.env.MESH_TMUX_SOCKET || "mesh", "send-keys", "-t", record.tmux, "Escape"], { stdio: "ignore" });
    child.on("error", () => resolve(1));
    child.on("close", resolve);
  });
  if (code !== 0) return false;
  const deadline = Date.now() + Math.min(timeout, 15_000);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (liveClaudeSessions().get(record.sessionId)?.status !== "busy") return true;
  }
  return false;
}

async function waitForGoal(sessionId, since, budget) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    const goal = readClaudeGoal(sessionId);
    if (goal.updatedAt && goal.updatedAt >= since) return goal;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}
