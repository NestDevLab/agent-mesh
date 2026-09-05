#!/usr/bin/env node
/** Detect active writers for a persisted agent session without attaching to it. */

import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { inspectClaudeSessionOwnership } from "./claude-session-ownership.mjs";

const procRoot = process.env.AGENT_WRITER_PROC_ROOT || "/proc";

const { values } = parseArgs({
  options: {
    agent: { type: "string" },
    session: { type: "string" },
    json: { type: "boolean", default: false },
    "require-free": { type: "boolean", default: false },
    "require-kind": { type: "string" },
    "forbid-kind": { type: "string" },
    "require-monitor-inbox": { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(`Usage:
  session-writer-status.mjs --agent codex|claude --session <ID> [--json]
  session-writer-status.mjs --agent claude --session <ID> --require-free
  session-writer-status.mjs --agent claude --session <ID> --require-kind claude-desktop
  session-writer-status.mjs --agent claude --session <ID> --forbid-kind claude-desktop
  session-writer-status.mjs --agent claude --session <ID> --require-monitor-inbox <JSONL>`);
  process.exit(0);
}

const agent = required(values.agent, "--agent");
const sessionId = required(values.session, "--session");
if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) fail("--session contains unsafe characters", 2);
if (agent !== "codex" && agent !== "claude") fail(`writer discovery is not implemented for agent ${agent}`, 2);

const claudeOwnership = agent === "claude" ? inspectClaudeSessionOwnership(sessionId, { procRoot }) : undefined;
const writers = agent === "codex" ? detectCodexWriters(sessionId) : claudeOwnership.writers;
const result = agent === "claude"
  ? { agent, sessionId, state: claudeOwnership.state, writers, discovery: claudeOwnership.discovery }
  : { agent, sessionId, writers };

if (values.json) console.log(JSON.stringify(result));
else for (const writer of writers) console.log(`${writer.kind}\t${writer.pid}`);

if (values["require-free"] && claudeOwnership?.state !== "free") {
  fail(
    claudeOwnership?.state === "unknown"
      ? `session ${sessionId} ownership is unknown; refusing resume because Claude inventory is incomplete`
      : `session ${sessionId} already has writer(s): ${summarize(writers)}`,
    claudeOwnership?.state === "unknown" ? 5 : 4,
  );
}

if (values["require-kind"]) {
  const kind = values["require-kind"];
  const matching = writers.filter((writer) => writer.kind === kind);
  if (!claudeOwnership?.discovery.complete || matching.length !== 1 || writers.length !== 1) {
    fail(
      `session ${sessionId} must have exactly one ${kind} writer; found ${summarize(writers)}`,
      4,
    );
  }
}

if (values["forbid-kind"] && writers.some((writer) => writer.kind === values["forbid-kind"])) {
  fail(`session ${sessionId} already has forbidden writer ${values["forbid-kind"]}`, 4);
}
if (values["forbid-kind"] && agent === "claude" && !claudeOwnership.discovery.complete) {
  fail(`session ${sessionId} ownership is incomplete; cannot exclude ${values["forbid-kind"]}`, 5);
}

if (agent === "claude" && claudeOwnership.state === "unknown" && !values["require-free"] && !values["require-kind"]) {
  fail(`session ${sessionId} ownership is unknown; Claude inventory is incomplete`, 5);
}

if (values["require-monitor-inbox"]) {
  const inbox = resolve(values["require-monitor-inbox"]);
  const watchers = detectMonitorInboxWatchers(inbox);
  if (watchers.length !== 1) {
    fail(`inbox ${inbox} must have exactly one event-driven Monitor watcher; found ${watchers.length}`, 4);
  }
}

function detectCodexWriters(id) {
  if (!existsSync(procRoot)) return [];
  const codexHome = process.env.CODEX_HOME || `${process.env.HOME || ""}/.codex`;
  const lockPath = resolve(codexHome, "thread-writer-locks", `${id}.lock`);
  if (!existsSync(lockPath)) return [];
  const writers = [];
  for (const entry of readdirSync(procRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    let argv;
    try {
      argv = readFileSync(`${procRoot}/${entry.name}/cmdline`, "utf8").split("\0").filter(Boolean);
    } catch {
      continue;
    }
    if (!argv.some((value) => basename(value) === "codex")) continue;
    let ownsLock = false;
    try {
      for (const fd of readdirSync(`${procRoot}/${entry.name}/fd`)) {
        try {
          if (resolve(readlinkSync(`${procRoot}/${entry.name}/fd/${fd}`)) === lockPath) {
            ownsLock = true;
            break;
          }
        } catch {
          // File descriptors can disappear while the process is inspected.
        }
      }
    } catch {
      continue;
    }
    if (ownsLock) writers.push({ pid: Number(entry.name), kind: "codex" });
  }
  return writers.sort((left, right) => left.pid - right.pid);
}

function detectMonitorInboxWatchers(inbox) {
  if (!existsSync(procRoot)) return [];
  const watchers = [];
  for (const entry of readdirSync(procRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    let argv;
    try {
      argv = readFileSync(`${procRoot}/${entry.name}/cmdline`, "utf8").split("\0").filter(Boolean);
    } catch {
      continue;
    }
    const scriptIndex = argv.findIndex((value) => basename(value) === "agent-inbox-watch.mjs");
    const inboxIndex = argv.indexOf("--inbox");
    if (
      scriptIndex < 0
      || inboxIndex < 0
      || !argv.includes("--follow")
      || !argv[inboxIndex + 1]
      || resolve(argv[inboxIndex + 1]) !== inbox
    ) continue;
    watchers.push(Number(entry.name));
  }
  return watchers.sort((left, right) => left - right);
}

function summarize(writers) {
  return writers.length
    ? writers.map((writer) => `${writer.kind}:${writer.pid}`).join(", ")
    : "none";
}

function required(value, flag) {
  const text = String(value || "").trim();
  if (!text) fail(`${flag} is required`, 2);
  return text;
}

function fail(message, code) {
  console.error(`session-writer-status: ${message}`);
  process.exit(code);
}
