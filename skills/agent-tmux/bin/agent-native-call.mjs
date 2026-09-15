#!/usr/bin/env node
/** Queue a correlated turn through a provider's native active-session control. */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { inspectClaudeSessionOwnership } from "./claude-session-ownership.mjs";

const { values } = parseArgs({
  options: {
    agent: { type: "string" },
    session: { type: "string" },
    "correlation-id": { type: "string" },
    timeout: { type: "string", default: "120" },
    message: { type: "string" },
    "managed-inbox-root": { type: "string" },
    help: { type: "boolean", short: "h", default: false }
  },
  strict: true
});

if (values.help) {
  console.log("Usage: agent-native-call.mjs --agent codex|claude --session <ID> --correlation-id <ID> --message <TEXT> [--timeout <SECONDS>]");
  process.exit(0);
}

const agent = required(values.agent, "--agent");
const sessionId = required(values.session, "--session");
const correlationId = required(values["correlation-id"], "--correlation-id");
const message = required(values.message, "--message");
const timeoutSeconds = Number(values.timeout);
if (agent !== "codex" && agent !== "claude") fail(`native active-session calls are not implemented for agent ${agent}`, 2);
if (!/^[A-Za-z0-9._:-]+$/.test(correlationId)) fail("--correlation-id contains unsafe characters", 2);
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
  fail("--session must be a complete UUID", 2);
}
if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) {
  fail("--timeout must be an integer from 1 to 600", 2);
}

const claudeInbox = agent === "claude"
  ? await requireManagedClaudeInbox(sessionId, correlationId, values["managed-inbox-root"])
  : undefined;

const initialTranscripts = await resolveTranscripts(agent, sessionId);
if (initialTranscripts.length === 0) fail(`no ${agent} transcript for session ${sessionId}`, 1);
const offsets = new Map();
for (const transcript of initialTranscripts) offsets.set(transcript, (await stat(transcript)).size);
const resultToken = createHash("sha256").update(correlationId).digest("hex").slice(0, 16);
const anchor = `[MESH:${resultToken}]`;
const resultBegin = `[[R:${resultToken}]]`;
const resultEnd = `[[/R:${resultToken}]]`;
const protocolMessage = `${anchor} Use the result protocol shown on the next line.\n` +
  `Final result markers: ${resultBegin} ... ${resultEnd}\n${message}`;

if (agent === "codex") {
  const queued = await run(process.env.CODEX_BIN || "codex", [
    "queue", "--thread", sessionId, "--message", protocolMessage
  ], (timeoutSeconds + 15) * 1000);
  if (queued.code !== 0) fail(safeError("Codex native queue failed", queued), 1);
} else {
  await appendManagedInbox(claudeInbox, {
    schema: "agent-mesh.monitor-inbox.v1",
    deliveryId: correlationId,
    meshId: correlationId,
    prompt: protocolMessage,
  });
}

const deadline = Date.now() + timeoutSeconds * 1000;
const transcriptStates = new Map();
let anchorSeen = false;
let uncorrelatedOutputSeen = false;
while (Date.now() < deadline) {
  for (const transcript of await resolveTranscripts(agent, sessionId)) {
    const state = transcriptStates.get(transcript) ?? {
      anchorSeen: false,
      finalBodies: [],
      eventBodies: []
    };
    transcriptStates.set(transcript, state);
    const consumed = await consumeTranscript(transcript, offsets.get(transcript) ?? 0);
    offsets.set(transcript, consumed.offset);
    for (const record of consumed.records) {
      const payload = record?.payload;
      const userText = agent === "codex" ? messageText(record, "user") : claudeMessageText(record, "user");
      if (userText?.includes(anchor)) {
        state.anchorSeen = true;
        anchorSeen = true;
        state.finalBodies = [];
        state.eventBodies = [];
        continue;
      }
      const assistantText = agent === "codex" ? messageText(record, "assistant") : claudeMessageText(record, "assistant");
      if (!state.anchorSeen) {
        if (assistantText) uncorrelatedOutputSeen = true;
        continue;
      }
      if (assistantText) {
        const bodies = agent === "claude"
          ? state.finalBodies
          : record.type === "response_item" && payload?.phase === "final_answer"
            ? state.finalBodies
            : record.type === "event_msg" ? state.eventBodies : undefined;
        if (bodies !== undefined && !bodies.includes(assistantText)) bodies.push(assistantText);
        if (agent === "codex") continue;
      }
      if (
        (agent === "codex" && record.type === "event_msg" && payload?.type === "task_complete") ||
        (agent === "claude" && record.type === "assistant" && record?.message?.stop_reason === "end_turn")
      ) {
        finish(
          state.finalBodies.length > 0 ? state.finalBodies : state.eventBodies,
          resultBegin,
          resultEnd
        );
      }
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

async function resolveTranscripts(agentName, id) {
  const root = agentName === "codex"
    ? process.env.CODEX_SESSION_ROOT || join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions")
    : process.env.CLAUDE_SESSION_ROOT || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  let entries;
  try { entries = await readdir(root, { recursive: true, withFileTypes: true }); }
  catch { return []; }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl") || !entry.name.includes(id)) continue;
    const path = join(entry.parentPath, entry.name);
    try {
      if (agentName === "claude" || await transcriptSessionId(path) === id) {
        candidates.push({ path, mtime: (await stat(path)).mtimeMs });
      }
    }
    catch { /* The transcript can rotate while discovery runs. */ }
  }
  candidates.sort((left, right) => left.mtime - right.mtime);
  return candidates.map((candidate) => candidate.path);
}

async function transcriptSessionId(path) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n")) {
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); }
      catch { continue; }
      if (record?.type === "session_meta") return record?.payload?.id;
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

async function consumeTranscript(path, start) {
  const size = (await stat(path)).size;
  if (size < start) start = 0;
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

function claudeMessageText(record, role) {
  if (role === "user") {
    const raw = JSON.stringify(record);
    return raw.includes("AGENT_MESH_INBOX") || raw.includes("agent-mesh.monitor-inbox.v1") ? raw :
      record?.type === "user" && typeof record?.message?.content === "string" ? record.message.content : undefined;
  }
  if (record?.type !== "assistant" || !Array.isArray(record?.message?.content)) return undefined;
  const parts = record.message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

async function requireManagedClaudeInbox(id, correlation, configuredRoot) {
  const root = String(configuredRoot || "").trim();
  if (!root) blockClaudeVisibleTurn(id, correlation, "claude_active_user_turn_unsupported");
  const inbox = resolve(root, `${id}.jsonl`);
  if (!inbox.startsWith(`${resolve(root)}/`)) blockClaudeVisibleTurn(id, correlation, "claude_managed_inbox_invalid");
  try { await access(inbox); }
  catch { blockClaudeVisibleTurn(id, correlation, "claude_managed_inbox_missing"); }
  const writerStatusPath = fileURLToPath(new URL("./session-writer-status.mjs", import.meta.url));
  const checked = await run(process.execPath, [
    writerStatusPath,
    "--agent", "claude",
    "--session", id,
    "--require-kind", "claude-desktop",
    "--require-monitor-inbox", inbox,
  ], 15_000);
  if (checked.code !== 0) blockClaudeVisibleTurn(id, correlation, "claude_managed_transport_unavailable");
  return inbox;
}

async function appendManagedInbox(path, record) {
  const handle = await open(path, "a", 0o600);
  try {
    await handle.write(`${JSON.stringify(record)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
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

function blockClaudeVisibleTurn(id, correlation, reasonOverride) {
  const ownership = inspectClaudeSessionOwnership(id);
  const desktopOwned = ownership.writers.some((writer) => writer.kind === "claude-desktop");
  const reason = reasonOverride || (ownership.state === "unknown"
    ? "claude_ownership_unknown"
    : desktopOwned
      ? "claude_active_user_turn_unsupported"
      : ownership.state === "owned"
        ? "claude_active_user_turn_unsupported"
        : "claude_session_not_active");
  const blocker = {
    schemaVersion: 1,
    adapter: "claude-active-session",
    status: "blocked",
    reason,
    agent: "claude",
    sessionId: id,
    correlationId: correlation,
    ownership,
    delivery: { attempted: false, visibleUserTurn: false, readBack: false },
    supportedInterfaces: {
      ownership: "claude agents --json",
      visibleUserTurn: null,
      excluded: [
        "claude --resume may copy an already-running session",
        "SendMessage is an agent message rather than a user turn",
      ],
    },
  };
  process.stdout.write(`${JSON.stringify(blocker)}\n`);
  process.exit(78);
}
