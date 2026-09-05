/** Resolve active Claude session ownership through documented inventory plus process evidence. */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";

export function inspectClaudeSessionOwnership(sessionId, options = {}) {
  const procRoot = options.procRoot || process.env.AGENT_WRITER_PROC_ROOT || "/proc";
  const claudeBin = options.claudeBin || process.env.CLAUDE_BIN || "claude";
  const processWriters = detectArgvWriters(sessionId, procRoot);
  const inventory = readAgentsInventory(claudeBin);
  const issues = [];
  const writers = new Map(processWriters.map((writer) => [writer.pid, writer]));

  if (inventory.complete) {
    for (const entry of inventory.entries) {
      if (entry?.sessionId !== sessionId || !Number.isInteger(entry?.pid) || entry.pid <= 0) continue;
      const argv = readProcessArgv(procRoot, entry.pid);
      const kind = classifyClaudeProcess(argv);
      if (!kind) {
        issues.push("owner_process_unverifiable");
        continue;
      }
      writers.set(entry.pid, { pid: entry.pid, kind, source: "claude-agents" });
    }
  } else {
    issues.push(inventory.reason);
  }

  const resolved = [...writers.values()].sort((left, right) => left.pid - right.pid);
  const complete = inventory.complete && issues.length === 0;
  return {
    state: resolved.length > 0 ? "owned" : complete ? "free" : "unknown",
    writers: resolved,
    discovery: {
      complete,
      source: "claude-agents",
      ...(issues.length > 0 ? { issues: [...new Set(issues)] } : {}),
    },
  };
}

function readAgentsInventory(claudeBin) {
  const result = spawnSync(claudeBin, ["agents", "--json"], {
    encoding: "utf8",
    timeout: Number(process.env.AGENT_CLAUDE_INVENTORY_TIMEOUT_MS || 5000),
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return { complete: false, entries: [], reason: "claude_agents_unavailable" };
  }
  try {
    const entries = JSON.parse(result.stdout);
    if (!Array.isArray(entries)) throw new Error("inventory is not an array");
    return { complete: true, entries };
  } catch {
    return { complete: false, entries: [], reason: "claude_agents_invalid_json" };
  }
}

function detectArgvWriters(sessionId, procRoot) {
  if (!existsSync(procRoot)) return [];
  const writers = [];
  for (const entry of readdirSync(procRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    const argv = readProcessArgv(procRoot, pid);
    if (!resumesSession(argv, sessionId)) continue;
    const kind = classifyClaudeProcess(argv);
    if (kind) writers.push({ pid, kind, source: "process-argv" });
  }
  return writers;
}

function readProcessArgv(procRoot, pid) {
  try {
    return readFileSync(`${procRoot}/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

function classifyClaudeProcess(argv) {
  if (!argv.length) return undefined;
  const executable = argv[0];
  if (executable.includes("/.claude/remote/ccd-cli/")) return "claude-desktop";
  if (basename(executable) === "claude") return "claude-cli";
  return undefined;
}

function resumesSession(argv, sessionId) {
  return argv.some((value, index) => (
    value === `--resume=${sessionId}`
    || ((value === "--resume" || value === "-r") && argv[index + 1] === sessionId)
  ));
}
