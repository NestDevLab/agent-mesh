#!/usr/bin/env node
/** Report Codex or Claude goals that stopped advancing and optionally restart the dropped ones. */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { goalCommand, liveClaudeSessions, readClaudeGoal, typeClaudeGoal } from "./claude-goal.mjs";
import { withCodexAppServer } from "./codex-app-server.mjs";

try {
  const { values } = parseArgs({
    options: {
      agent: { type: "string", default: "codex" },
      "idle-minutes": { type: "string", default: "20" },
      "max-age-hours": { type: "string", default: "48" },
      "include-paused": { type: "boolean", default: false },
      nudge: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log("Usage: agent-goal-watch.mjs [--agent codex|claude] [--idle-minutes N] [--max-age-hours N] [--include-paused] [--nudge] [--json]");
    process.exit(0);
  }
  const idleMinutes = positive(values["idle-minutes"], "--idle-minutes");
  const maxAgeHours = positive(values["max-age-hours"], "--max-age-hours");
  const now = Date.now();
  if (!["codex", "claude"].includes(values.agent)) throw Object.assign(new Error("--agent must be codex or claude"), { exitCode: 2 });
  if (values.agent === "claude") {
    print(await watchClaude(idleMinutes, maxAgeHours, values.nudge, now), values.json);
    process.exit();
  }
  const goals = readGoals(values["include-paused"]).filter((goal) => {
    const idle = now - goal.updated_at_ms;
    return idle >= idleMinutes * 60_000 && idle <= maxAgeHours * 3_600_000;
  });
  const timeout = Number(process.env.AGENT_GOAL_TIMEOUT_MS || 30000);
  const report = goals.length === 0 ? [] : await withCodexAppServer({
    clientName: "agent-mesh-goal-watch",
    timeout: timeout * Math.max(1, goals.length),
    timeoutMessage: "app-server goal watch timed out; goal state unknown",
  }, async (request) => {
    const rows = [];
    for (const goal of goals) {
      const row = {
        threadId: goal.thread_id,
        status: goal.status,
        objective: goal.objective.slice(0, 160),
        idleMinutes: Math.floor((now - goal.updated_at_ms) / 60_000),
      };
      try {
        const { data } = await request("thread/turns/list", { threadId: goal.thread_id, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
        row.turnInProgress = data?.[0]?.status === "inProgress";
      } catch (error) {
        row.error = error.message;
        rows.push(row);
        continue;
      }
      if (row.turnInProgress) continue;
      // Only an `active` goal with no running turn is a lost continuation. Blocked and paused
      // goals wait for someone, so they are reported and left to their owner.
      row.state = goal.status === "active" ? "stalled" : "waiting";
      if (values.nudge && row.state === "stalled") {
        try {
          await request("thread/resume", { threadId: goal.thread_id });
          const updated = await request("thread/goal/set", { threadId: goal.thread_id, status: "active", origin: "user" });
          row.nudged = updated?.goal?.status === "active";
        } catch (error) {
          row.nudged = false;
          row.error = error.message;
        }
      }
      rows.push(row);
    }
    return rows;
  });
  print(report, values.json);
} catch (error) {
  console.error(`agent-goal-watch: ${error.message}`);
  process.exitCode = error.exitCode || 1;
}

function print(report, json) {
  if (json) console.log(JSON.stringify({ goals: report }));
  else if (report.length === 0) console.log("no stalled or waiting goals");
  else for (const row of report) {
    console.log(`${row.threadId ?? row.sessionId} ${row.state ?? "unknown"} (${row.status}, idle ${row.idleMinutes}m)` +
      `${row.nudged ? " nudged" : ""}${row.error ? ` error: ${row.error}` : ""} ${row.objective}`);
  }
}

// Claude has no goal database: the latest goal_status attachment in each recent transcript is the state.
async function watchClaude(idleMinutes, maxAgeHours, nudge, now) {
  const root = process.env.CLAUDE_SESSION_ROOT
    || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  const lastActivity = new Map();
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    for (const name of readdirSync(join(root, project.name))) {
      const id = name.match(/^([0-9a-f-]{36})\.jsonl$/i)?.[1];
      if (!id) continue;
      const mtime = statSync(join(root, project.name, name)).mtimeMs;
      if (mtime > (lastActivity.get(id) ?? 0)) lastActivity.set(id, mtime);
    }
  }
  const live = liveClaudeSessions();
  const timeout = Number(process.env.AGENT_GOAL_TIMEOUT_MS || 30000);
  const rows = [];
  for (const [sessionId, mtime] of lastActivity) {
    const idle = now - mtime;
    if (idle < idleMinutes * 60_000 || idle > maxAgeHours * 3_600_000) continue;
    const goal = readClaudeGoal(sessionId);
    if (goal.state !== "active") continue;
    const record = live.get(sessionId);
    if (record?.status === "busy") continue;
    const row = { sessionId, status: goal.state, objective: goal.condition.slice(0, 160), idleMinutes: Math.floor(idle / 60_000) };
    // Without a live process nothing can resume the goal; it waits for someone to reopen the session.
    row.state = record ? "stalled" : "orphaned";
    if (nudge && record) {
      try {
        row.nudged = (await typeClaudeGoal(record, goalCommand("set", goal.condition), timeout)).status === "submitted";
      } catch (error) {
        row.nudged = false;
        row.error = error.message;
      }
    }
    rows.push(row);
  }
  return rows;
}

function readGoals(includePaused) {
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  const path = process.env.CODEX_GOALS_DB || join(home, "goals_1.sqlite");
  if (!existsSync(path)) throw new Error(`no Codex goals database at ${path}`);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const statuses = includePaused ? ["active", "blocked", "paused"] : ["active", "blocked"];
    return db.prepare(`SELECT thread_id, objective, status, updated_at_ms FROM thread_goals
      WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY updated_at_ms`).all(...statuses);
  } finally {
    db.close();
  }
}

function positive(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw Object.assign(new Error(`${flag} must be a positive number`), { exitCode: 2 });
  return number;
}
