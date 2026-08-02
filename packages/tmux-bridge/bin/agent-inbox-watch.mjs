#!/usr/bin/env node
/** Stream durable session-link inbox records as Claude Monitor notifications. */

import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

const STATE_SCHEMA = "agent-mesh.monitor-inbox-cursor.v1";
const { values } = parseArgs({
  options: {
    inbox: { type: "string" },
    state: { type: "string" },
    drain: { type: "boolean", default: false },
    follow: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(`Usage:
  agent-inbox-watch.mjs --inbox <JSONL> --state <FILE> --drain
  agent-inbox-watch.mjs --inbox <JSONL> --state <FILE> --follow`);
  process.exit(0);
}

const inboxPath = resolve(required(values.inbox, "--inbox"));
const statePath = resolve(required(values.state, "--state"));
if (values.drain === values.follow) fail("choose exactly one of --drain or --follow");
if (!existsSync(inboxPath)) fail(`inbox does not exist: ${inboxPath}`);

let cursor = loadCursor();
drain();
if (values.drain) process.exit(0);

let scheduled = false;
const watcher = watch(dirname(inboxPath), (event, filename) => {
  if (filename && String(filename) !== basename(inboxPath)) return;
  if (scheduled) return;
  scheduled = true;
  setImmediate(() => {
    scheduled = false;
    try {
      drain();
    } catch (error) {
      console.error(`agent-inbox-watch: ${error.message}`);
    }
  });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    watcher.close();
    process.exit(0);
  });
}
await new Promise(() => {});

function drain() {
  const size = statSync(inboxPath).size;
  if (size < cursor.offset) cursor.offset = 0;
  if (size <= cursor.offset) return;

  const length = size - cursor.offset;
  const buffer = Buffer.alloc(length);
  const descriptor = openSync(inboxPath, "r");
  try {
    readSync(descriptor, buffer, 0, length, cursor.offset);
  } finally {
    closeSync(descriptor);
  }

  const newline = buffer.lastIndexOf(0x0a);
  if (newline < 0) return;
  const consumed = buffer.subarray(0, newline + 1).toString("utf8");
  for (const line of consumed.split(/\r?\n/).filter(Boolean)) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.schema !== "agent-mesh.monitor-inbox.v1" || typeof record.prompt !== "string") continue;
    process.stdout.write(`AGENT_MESH_INBOX ${JSON.stringify(record)}\n`);
  }
  cursor.offset += newline + 1;
  saveCursor();
}

function loadCursor() {
  if (!existsSync(statePath)) return { schema: STATE_SCHEMA, inbox: inboxPath, offset: 0 };
  let value;
  try {
    value = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    fail(`cannot read cursor ${statePath}: ${error.message}`);
  }
  if (value?.schema !== STATE_SCHEMA || value.inbox !== inboxPath || !Number.isInteger(value.offset)) {
    fail(`cursor does not belong to inbox ${inboxPath}`);
  }
  return value;
}

function saveCursor() {
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(cursor)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, statePath);
}

function required(value, flag) {
  const text = String(value || "").trim();
  if (!text) fail(`${flag} is required`);
  return text;
}

function fail(message) {
  console.error(`agent-inbox-watch: ${message}`);
  process.exit(2);
}
