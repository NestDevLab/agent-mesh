#!/usr/bin/env node
/** Queue a correlated turn through a provider's native active-session control. */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    agent: { type: "string" },
    session: { type: "string" },
    "correlation-id": { type: "string" },
    timeout: { type: "string", default: "120" },
    message: { type: "string" },
    help: { type: "boolean", short: "h", default: false }
  },
  strict: true
});

if (values.help) {
  console.log("Usage: agent-native-call.mjs --agent codex --session <ID> --correlation-id <ID> --message <TEXT> [--timeout <SECONDS>]");
  process.exit(0);
}

const agent = required(values.agent, "--agent");
const sessionId = required(values.session, "--session");
const correlationId = required(values["correlation-id"], "--correlation-id");
const message = required(values.message, "--message");
const timeoutSeconds = Number(values.timeout);
if (agent !== "codex") fail(`native active-session calls are not implemented for agent ${agent}`, 2);
if (!/^[A-Za-z0-9._:-]+$/.test(correlationId)) fail("--correlation-id contains unsafe characters", 2);
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
  fail("--session must be a complete UUID", 2);
}
if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) {
  fail("--timeout must be an integer from 1 to 600", 2);
}

const transcript = await resolveTranscript(sessionId);
if (transcript === undefined) fail(`no Codex transcript for session ${sessionId}`, 1);
let offset = (await stat(transcript)).size;
const resultToken = createHash("sha256").update(correlationId).digest("hex").slice(0, 16);
const anchor = `[MESH:${resultToken}]`;
const resultBegin = `[[R:${resultToken}]]`;
const resultEnd = `[[/R:${resultToken}]]`;
const protocolMessage = `${anchor} Use the result protocol shown on the next line.\n` +
  `Final result markers: ${resultBegin} ... ${resultEnd}\n${message}`;

const queued = await run(process.env.CODEX_BIN || "codex", [
  "queue", "--thread", sessionId, "--message", protocolMessage
], (timeoutSeconds + 15) * 1000);
if (queued.code !== 0) fail(safeError("Codex native queue failed", queued), 1);

const deadline = Date.now() + timeoutSeconds * 1000;
let anchorSeen = false;
let agentBodies = [];
let uncorrelatedOutputSeen = false;
while (Date.now() < deadline) {
  const consumed = await consumeTranscript(transcript, offset);
  offset = consumed.offset;
  for (const record of consumed.records) {
    const payload = record?.payload;
    if (typeof payload !== "object" || payload === null) continue;
    const userText = messageText(record, "user");
    if (userText?.includes(anchor)) {
      anchorSeen = true;
      agentBodies = [];
      continue;
    }
    const assistantText = messageText(record, "assistant");
    if (!anchorSeen) {
      if (assistantText) uncorrelatedOutputSeen = true;
      continue;
    }
    if (assistantText) {
      agentBodies.push(assistantText);
      continue;
    }
    if (record.type === "event_msg" && payload.type === "task_complete") {
      finish(agentBodies, resultBegin, resultEnd);
    }
  }
  await sleep(Number(process.env.AGENT_NATIVE_CALL_POLL_MS || 250));
}
fail(
  !anchorSeen && uncorrelatedOutputSeen
    ? "Agent output was produced but not correlated to the queued turn."
    : "native session result collection timed out",
  !anchorSeen && uncorrelatedOutputSeen ? 66 : 124
);

function finish(bodies, begin, end) {
  const text = bodies.join("\n");
  const beginIndex = text.lastIndexOf(begin);
  const endIndex = beginIndex < 0 ? -1 : text.indexOf(end, beginIndex + begin.length);
  if (beginIndex >= 0 && endIndex >= 0) {
    const result = text.slice(beginIndex + begin.length, endIndex).trim();
    if (!result) fail("Agent produced no textual result.", 65);
    process.stdout.write(`${result}\n`);
    process.exit(0);
  }
  if (bodies.length === 0) fail("Agent produced no textual result.", 65);
  if (beginIndex >= 0 || text.includes(end)) fail("Correlated result markers could not be parsed.", 67);
  // The unique user-turn anchor plus the following task_complete event already
  // establishes deterministic correlation. Markers remain an optional stronger
  // extraction protocol for agents that honor them.
  process.stdout.write(`${text.trim()}\n`);
  process.exit(0);
}

function messageText(record, role) {
  const payload = record?.payload;
  if (record?.type === "event_msg") {
    if (role === "user" && payload?.type === "user_message" && typeof payload.message === "string") {
      return payload.message;
    }
    if (role === "assistant" && payload?.type === "agent_message" && typeof payload.message === "string") {
      return payload.message;
    }
    return undefined;
  }
  if (record?.type !== "response_item" || payload?.type !== "message" || payload.role !== role || !Array.isArray(payload.content)) {
    return undefined;
  }
  const contentType = role === "user" ? "input_text" : "output_text";
  const parts = payload.content
    .filter((part) => part?.type === contentType && typeof part.text === "string")
    .map((part) => part.text);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

async function resolveTranscript(id) {
  const root = process.env.CODEX_SESSION_ROOT || join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
  let entries;
  try { entries = await readdir(root, { recursive: true, withFileTypes: true }); }
  catch { return undefined; }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl") || !entry.name.includes(id)) continue;
    const path = join(entry.parentPath, entry.name);
    try { candidates.push({ path, mtime: (await stat(path)).mtimeMs }); }
    catch { /* The transcript can rotate while discovery runs. */ }
  }
  candidates.sort((left, right) => right.mtime - left.mtime);
  return candidates[0]?.path;
}

async function consumeTranscript(path, start) {
  const size = (await stat(path)).size;
  if (size <= start) return { offset: start, records: [] };
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const newline = buffer.lastIndexOf(0x0a);
    if (newline < 0) return { offset: start, records: [] };
    const records = buffer.subarray(0, newline + 1).toString("utf8").split("\n").flatMap((line) => {
      if (!line) return [];
      try { return [JSON.parse(line)]; }
      catch { return []; }
    });
    return { offset: start + newline + 1, records };
  } finally {
    await handle.close();
  }
}

function run(command, args, timeoutMs) {
  return new Promise((resolveRun) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolveRun({
        code: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" && stderr ? stderr : error instanceof Error ? error.message : ""
      });
    });
  });
}

function safeError(prefix, result) {
  const detail = result.stderr.trim().split(/\r?\n/).at(-1);
  return detail ? `${prefix}: ${detail}` : `${prefix}: exit ${result.code}`;
}

function required(value, flag) {
  const text = String(value || "").trim();
  if (!text) fail(`${flag} is required`, 2);
  return text;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(10, ms)));
}

function fail(message, code) {
  process.stderr.write(`agent-native-call: ${message}\n`);
  process.exit(code);
}
