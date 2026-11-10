#!/usr/bin/env node
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const TAIL_BYTES = 1024 * 1024;
const SILENT_TURN_MS = 15 * 60 * 1000;
const STEP_CHARS = 160;
const CHECKLIST_ITEMS = 20;

const { values } = parseArgs({
  options: { agent: { type: "string" }, session: { type: "string" } },
  strict: true
});
if (!["codex", "claude"].includes(values.agent) || !/^[A-Za-z0-9_-]{1,128}$/.test(values.session ?? "")) {
  console.error("Usage: agent-session-status.mjs --agent codex|claude --session <ID>");
  process.exit(2);
}

const transcript = await newestTranscript(values.agent, values.session);
const records = transcript === undefined ? [] : await tailRecords(transcript);
const turn = values.agent === "codex" ? codexTurn(records) : claudeTurn(records);
const silentFor = turn.at === undefined ? Infinity : Date.now() - Date.parse(turn.at);
const state = !turn.seen ? "unknown" : !turn.open ? "free" : silentFor > SILENT_TURN_MS ? "unknown" : "busy";
console.log(JSON.stringify({
  state,
  last_activity_at: turn.at ?? null,
  last_step: turn.step ?? null,
  checklist: state === "busy" ? turn.checklist.slice(0, CHECKLIST_ITEMS) : []
}));

function claudeTurn(items) {
  const turn = { seen: false, open: false, checklist: [] };
  for (const record of items) {
    if (record?.isSidechain || record?.isMeta || !["user", "assistant"].includes(record?.type)) continue;
    turn.seen = true;
    turn.at = record.timestamp ?? turn.at;
    if (record.type === "user") {
      turn.open = !JSON.stringify(record.message?.content ?? "").includes("[Request interrupted");
      continue;
    }
    turn.open = record.message?.stop_reason !== "end_turn";
    for (const part of Array.isArray(record.message?.content) ? record.message.content : []) {
      if (part?.type === "text" && part.text?.trim()) turn.step = firstLine(part.text);
      if (part?.type !== "tool_use") continue;
      turn.step = `tool: ${part.name}`;
      if (part.name === "TodoWrite" && Array.isArray(part.input?.todos)) {
        turn.checklist = part.input.todos.map((todo) => ({ text: firstLine(String(todo.content ?? "")), status: String(todo.status ?? "") }));
      }
    }
  }
  return turn;
}

function codexTurn(items) {
  const turn = { seen: false, open: false, checklist: [] };
  for (const record of items) {
    const payload = record?.payload;
    if (record?.type === "event_msg") {
      if (payload?.type === "task_started") Object.assign(turn, { seen: true, open: true, checklist: [] });
      if (payload?.type === "task_complete" || payload?.type === "turn_aborted") Object.assign(turn, { seen: true, open: false });
      if (payload?.type === "agent_message" && typeof payload.message === "string") turn.step = firstLine(payload.message);
    }
    if (record?.type === "response_item" && payload?.type === "function_call") {
      turn.step = `tool: ${payload.name}`;
      if (payload.name === "update_plan") turn.checklist = codexPlan(payload.arguments) ?? turn.checklist;
    }
    if (turn.seen) turn.at = record?.timestamp ?? turn.at;
  }
  return turn;
}

function codexPlan(args) {
  try {
    return JSON.parse(args).plan.map((item) => ({ text: firstLine(String(item.step ?? "")), status: String(item.status ?? "") }));
  } catch { return undefined; }
}

function firstLine(text) {
  return text.trim().split(/\r?\n/, 1)[0].slice(0, STEP_CHARS);
}

async function newestTranscript(agent, id) {
  const root = agent === "codex"
    ? process.env.CODEX_SESSION_ROOT || join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions")
    : process.env.CLAUDE_SESSION_ROOT || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  let newest;
  let entries;
  try { entries = await readdir(root, { recursive: true, withFileTypes: true }); }
  catch { return undefined; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl") || !entry.name.includes(id)) continue;
    const path = join(entry.parentPath, entry.name);
    try {
      const mtime = (await stat(path)).mtimeMs;
      if (newest === undefined || mtime > newest.mtime) newest = { path, mtime };
    } catch { /* can rotate mid scan */ }
  }
  return newest?.path;
}

async function tailRecords(path) {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.flatMap((line) => {
      try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; }
    });
  } finally {
    await handle.close();
  }
}
