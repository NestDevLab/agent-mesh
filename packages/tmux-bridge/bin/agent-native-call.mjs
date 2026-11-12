#!/usr/bin/env node
/** Queue a correlated turn through a provider's native active-session control. */

import { commsLease } from "./comms-client.mjs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { inspectClaudeSessionOwnership } from "./claude-session-ownership.mjs";

let activeComms;
let enqueueStarted = false;
try {
const { values } = parseArgs({
  options: {
    agent: { type: "string" },
    session: { type: "string" },
    "correlation-id": { type: "string" },
    timeout: { type: "string", default: "120" },
    "delivery-only": { type: "boolean", default: false },
    cloud: { type: "boolean", default: false },
    "steer-or-queue": { type: "boolean", default: false },
    resume: { type: "boolean", default: false },
    "no-resume": { type: "boolean", default: false },
    message: { type: "string" },
    "managed-inbox-root": { type: "string" },
    help: { type: "boolean", short: "h", default: false }
  },
  strict: true
});

if (values.help) {
  console.log("Usage: agent-native-call.mjs --agent codex|claude --session <ID> --correlation-id <ID> --message <TEXT> [--timeout <SECONDS>] [--resume (Codex only)] [--cloud --delivery-only (Claude cloud only)] [--steer-or-queue (Codex only)] [--delivery-only]");
  process.exit(0);
}

const agent = required(values.agent, "--agent");
const sessionId = required(values.session, "--session");
const correlationId = required(values["correlation-id"], "--correlation-id");
const message = required(values.message, "--message");
const timeoutSeconds = Number(values.timeout);
if (agent !== "codex" && agent !== "claude") fail(`native active-session calls are not implemented for agent ${agent}`, 2);
if (values.resume && values["no-resume"]) fail("--resume and --no-resume are mutually exclusive", 2);
if (values["no-resume"] && agent !== "codex") fail("--no-resume is supported only for Codex", 2);
const resume = agent === "codex" && !values["no-resume"];
if (values.resume && agent !== "codex") fail("--resume is supported only for Codex", 2);
if (!/^[A-Za-z0-9._:-]+$/.test(correlationId)) fail("--correlation-id contains unsafe characters", 2);
if (values["steer-or-queue"] && (agent !== "codex" || values.cloud)) {
  fail("--steer-or-queue requires --agent codex without --cloud", 2);
}
if (values.cloud && (agent !== "claude" || !values["delivery-only"] || values.resume || values["managed-inbox-root"])) {
  fail("--cloud requires --agent claude --delivery-only, without --resume or --managed-inbox-root", 2);
}
if (values.cloud ? !/^(session|cse)_[A-Za-z0-9]{1,128}$/.test(sessionId)
  : !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
  fail(values.cloud ? "--session must be an exact session_ or cse_ cloud ID" : "--session must be a complete UUID", 2);
}
if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) {
  fail("--timeout must be an integer from 1 to 600", 2);
}

const resultToken = createHash("sha256").update(correlationId).digest("hex").slice(0, 16);
const anchor = `[MESH:${resultToken}]`;
const resultBegin = `[[R:${resultToken}]]`;
const resultEnd = `[[/R:${resultToken}]]`;
const protocolMessage = values["delivery-only"] ? message : `${anchor} Use the result protocol shown on the next line.\n` +
  `Final result markers: ${resultBegin} ... ${resultEnd}\n` +
  `Put your reply between them in your final message. The sender is a temporary bridge that can't be messaged, ` +
  `so don't answer with a messaging tool, the caller reads your reply from the task.\n${message}`;

const comms = await commsLease({ kind: 'native', runtime: agent, destination: sessionId,
  correlation: correlationId, message: protocolMessage, inbox_root: values['managed-inbox-root'], resume, ...(values.cloud ? { cloud: true } : {}),
  ...(values["steer-or-queue"] ? { steer_first: true } : {}) });
activeComms = comms;
if (comms.status !== 'send') {
  await comms.complete(false);
  activeComms = undefined;
  console.log(JSON.stringify({ status: comms.status, held: true, commsId: comms.id, agent, sessionId, correlationId }));
  process.exit(0);
}
// Cloud follow-ups have a provider queue acknowledgement, but no local transcript.
// All failures after invoking the provider retain the gate's unknown receipt.
if (values.cloud) {
  enqueueStarted = true;
  const sent = await run(process.env.CLAUDE_BIN || "claude", [
    "-p", "--cloud", sessionId, "--output-format", "json"
  ], timeoutSeconds * 1000, message);
  let receipt;
  try { receipt = JSON.parse(sent.stdout); } catch { /* Unproven acceptance. */ }
  if (sent.code !== 0 || receipt?.ok !== true || receipt.session_id !== sessionId) {
    fail("Claude cloud acceptance is unverified; inspect before retrying", 70);
  }
  await comms.complete(true);
  activeComms = undefined;
  console.log(JSON.stringify({ status: "queued", agent, sessionId, correlationId,
    commsId: comms.id, transport: "claude-cloud", readBack: false, responseObserved: false }));
  process.exit(0);
}

const claudeInbox = agent === "claude"
  ? await requireManagedClaudeInbox(sessionId, correlationId, values["managed-inbox-root"])
  : undefined;

const initialTranscripts = await resolveTranscripts(agent, sessionId);
if (initialTranscripts.length === 0) fail(`no ${agent} transcript for session ${sessionId}`, 1);
const offsets = new Map();
for (const transcript of initialTranscripts) offsets.set(transcript, (await stat(transcript)).size);
let resumeDiagnostic = false;
let transportAccepted = false;
let deliveryMethod;
let steeredTurnId;
try {
if (agent === "codex") {
  if (values["steer-or-queue"]) {
    enqueueStarted = true;
    const steered = await run(process.execPath, [
      fileURLToPath(new URL("./agent-steer.mjs", import.meta.url)),
      "--agent", "codex", sessionId, "--message", protocolMessage, "--json"
    ], timeoutSeconds * 1000);
    if (steered.code === 0) {
      let receipt;
      try { receipt = JSON.parse(steered.stdout); } catch { /* Unproven acceptance. */ }
      if (receipt?.agent !== "codex" || receipt.sessionId !== sessionId || receipt.status !== "steered" ||
          typeof receipt.turnId !== "string" || !receipt.turnId.trim()) {
        fail("Codex steer acceptance is unverified; inspect before retrying", 70);
      }
      deliveryMethod = "steer";
      steeredTurnId = receipt.turnId;
    } else if (steered.code === 3) {
      // The existing steer adapter proves no active turn and no send.
      enqueueStarted = false;
    } else {
      fail("Codex steer outcome is uncertain; no queue fallback; inspect before retrying", 70);
    }
  }
  if (deliveryMethod !== "steer") {
    enqueueStarted = true;
    const queued = await run(process.env.CODEX_BIN || "codex", [
      "queue", "--thread", sessionId, "--message", protocolMessage, ...(resume ? ["--resume"] : [])
    ], (timeoutSeconds + 15) * 1000);
    if (queued.code !== 0) {
      if (codexSessionIsNotDirectlyWritable(queued)) {
        fail("Codex spawned sub-agent sessions are readable but do not accept direct queued turns.", 79);
      }
      fail(safeError("Codex native queue failed", queued), 1);
    }
    resumeDiagnostic = Boolean(resume && queued.stderr?.trim());
    deliveryMethod = "queue";
  }
} else {
  enqueueStarted = true;
  await appendManagedInbox(claudeInbox, {
    schema: "agent-mesh.monitor-inbox.v1",
    deliveryId: correlationId,
    meshId: correlationId,
    prompt: protocolMessage,
    commsPermit: comms.id,
  });
}

  transportAccepted = true;
} finally {
  await comms.complete(transportAccepted, !enqueueStarted);
  activeComms = undefined;
}

// Queue acknowledgement is transport proof, never proof that the turn ran.
if (values["delivery-only"]) {
  console.log(JSON.stringify({ status: deliveryMethod === "steer" ? "steered" : "queued", agent, sessionId, correlationId,
    ...(values["steer-or-queue"] ? { deliveryMethod, ...(steeredTurnId ? { turnId: steeredTurnId } : {}) } : {}),
    ...(resume && deliveryMethod === "queue" ? { resumeRequested: true, resumeVerified: false, resumeDiagnostic } : {}) }));
  process.exit(0);
}

const deadline = Date.now() + timeoutSeconds * 1000;
const transcriptStates = new Map();
let anchorSeen = false;
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
        continue;
      }
      if (agent === "claude") {
        // a marked reply sent through a tool is final, the turn can go on for minutes after it
        const marked = claudeMarkedToolText(record, resultBegin, resultEnd);
        if (marked) finish([marked], resultBegin, resultEnd);
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
        (agent === "claude" && assistantText && record.type === "assistant" && record?.message?.stop_reason === "end_turn")
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
  anchorSeen
    ? "correlated native session result collection timed out"
    : "queued turn did not start before native session result collection timed out",
  124
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

function run(command, args, timeoutMs, input) {
  return new Promise((resolveRun) => {
    const child = execFile(command, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolveRun({
        code: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" && stderr ? stderr : error instanceof Error ? error.message : ""
      });
    });
    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

function safeError(prefix, result) {
  const detail = result.stderr.trim().split(/\r?\n/).at(-1);
  return detail ? `${prefix}: ${detail}` : `${prefix}: exit ${result.code}`;
}

function codexSessionIsNotDirectlyWritable(result) {
  const detail = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return detail.includes("direct app-server input is not allowed for unloaded spawned sub-agents")
    || detail.includes("direct app-server input is not allowed for multi-agent v2 sub-agents");
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

function claudeMarkedToolText(record, begin, end) {
  if (record?.type !== "assistant" || !Array.isArray(record?.message?.content)) return undefined;
  return record.message.content
    .filter((part) => part?.type === "tool_use" && typeof part.input?.message === "string")
    .map((part) => part.input.message)
    // the prompt quotes both markers, a session forwarding it verbatim isn't replying
    .find((text) => text.trimStart().startsWith(begin) && text.includes(end));
}

async function requireManagedClaudeInbox(id, correlation, configuredRoot) {
  const root = String(configuredRoot || "").trim();
  if (!root) blockClaudeVisibleTurn(id, correlation, "claude_managed_inbox_root_missing");
  const inbox = resolve(root, `${id}.jsonl`);
  if (!inbox.startsWith(`${resolve(root)}/`)) blockClaudeVisibleTurn(id, correlation, "claude_managed_inbox_invalid");
  try { await access(inbox); }
  catch { blockClaudeVisibleTurn(id, correlation, "claude_managed_inbox_missing"); }
  const writerStatusPath = fileURLToPath(new URL("./session-writer-status.mjs", import.meta.url));
  const checked = await run(process.execPath, [
    writerStatusPath,
    "--agent", "claude",
    "--session", id,
    "--require-single",
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
  throw Object.assign(new Error(message), { exitCode: code });
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
  throw Object.assign(new Error(reasonOverride || "Claude native delivery unavailable"), { exitCode: 78 });
}

} catch (error) {
  if (activeComms) {
    await activeComms.complete(false, !enqueueStarted);
  }
  process.stderr.write(`agent-native-call: ${error.message}\n`);
  process.exit(error.exitCode || 1);
}
