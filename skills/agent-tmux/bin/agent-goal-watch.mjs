#!/usr/bin/env node
/** Report Codex goals that stopped advancing and optionally restart the ones Codex dropped. */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { withCodexAppServer } from "./codex-app-server.mjs";

try {
  const { values } = parseArgs({
    options: {
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
    console.log("Usage: agent-goal-watch.mjs [--idle-minutes N] [--max-age-hours N] [--include-paused] [--nudge] [--json]");
    process.exit(0);
  }
  const idleMinutes = positive(values["idle-minutes"], "--idle-minutes");
  const maxAgeHours = positive(values["max-age-hours"], "--max-age-hours");
  const now = Date.now();
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
  if (values.json) console.log(JSON.stringify({ goals: report }));
  else if (report.length === 0) console.log("no stalled or waiting goals");
  else for (const row of report) {
    console.log(`${row.threadId} ${row.state ?? "unknown"} (${row.status}, idle ${row.idleMinutes}m)` +
      `${row.nudged ? " nudged" : ""}${row.error ? ` error: ${row.error}` : ""} ${row.objective}`);
  }
} catch (error) {
  console.error(`agent-goal-watch: ${error.message}`);
  process.exitCode = error.exitCode || 1;
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
