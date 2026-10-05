#!/usr/bin/env node
/** Read one correlated Claude result, unclipped, from the session's native transcript. */

import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    session: { type: "string" },
    "correlation-id": { type: "string" },
    wait: { type: "string", default: "0" },
    root: { type: "string" }
  },
  strict: true
});

const sessionId = values.session ?? "";
const correlationId = values["correlation-id"] ?? "";
const waitSeconds = Number(values.wait);
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) fail("--session must be a complete UUID", 2);
if (!/^[A-Za-z0-9._:-]+$/.test(correlationId)) fail("--correlation-id contains unsafe characters", 2);
if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 14_400) fail("--wait must be an integer from 0 to 14400", 2);

const root = values.root || process.env.CLAUDE_SESSION_ROOT || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
const token = createHash("sha256").update(correlationId).digest("hex").slice(0, 16);
const begin = `[[R:${token}]]`;
const end = `[[/R:${token}]]`;
const deadline = Date.now() + waitSeconds * 1000;
const pollMs = Number(process.env.AGENT_TRANSCRIPT_RESULT_POLL_MS || 5000);

while (true) {
  const outcome = await collect();
  if (outcome.kind === "found") {
    if (!outcome.text) fail("Agent produced no textual result.", 65);
    writeAll(`${outcome.text}\n`);
    process.exit(0);
  }
  if (Date.now() >= deadline) {
    if (outcome.kind === "ambiguous") fail("Correlated result markers could not be parsed.", 67);
    fail("No correlated result in the session transcript yet.", 124);
  }
  await new Promise((resolveSleep) => setTimeout(resolveSleep, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
}

async function collect() {
  const path = await transcriptPath();
  if (path === undefined) return { kind: "missing" };
  let raw;
  try { raw = await readFile(path, "utf8"); }
  catch { return { kind: "missing" }; }
  const texts = [];
  for (const line of raw.split("\n")) {
    if (!line.includes(token)) continue;
    let record;
    try { record = JSON.parse(line); }
    catch { continue; }
    if (record?.type !== "assistant" || !Array.isArray(record?.message?.content)) continue;
    for (const part of record.message.content) {
      if (part?.type === "text" && typeof part.text === "string" && part.text.includes(begin)) texts.push(part.text);
    }
  }
  if (texts.length === 0) return { kind: "missing" };
  // exactly one text block with exactly one marker pair, anything else isn't trustworthy
  if (texts.length > 1) return { kind: "ambiguous" };
  const text = texts[0];
  const start = text.indexOf(begin);
  const finish = text.indexOf(end, start + begin.length);
  if (finish < 0 || text.indexOf(begin, start + begin.length) >= 0 || text.indexOf(end, finish + end.length) >= 0) {
    return { kind: "ambiguous" };
  }
  return { kind: "found", text: text.slice(start + begin.length, finish).trim() };
}

async function transcriptPath() {
  let entries;
  try { entries = await readdir(root, { recursive: true, withFileTypes: true }); }
  catch { return undefined; }
  const match = entries.find((entry) => entry.isFile() && entry.name === `${sessionId}.jsonl`);
  return match === undefined ? undefined : join(match.parentPath, match.name);
}

// process.exit() right after an async stdout write cuts piped output at 8 KiB.
function writeAll(text) {
  const buffer = Buffer.from(text);
  let offset = 0;
  while (offset < buffer.length) {
    try { offset += writeSync(1, buffer, offset); }
    catch (error) { if (error.code !== "EAGAIN") throw error; }
  }
}

function fail(message, code) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(code);
}
