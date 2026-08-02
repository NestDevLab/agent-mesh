#!/usr/bin/env node
/** Connect two persisted agent sessions through the existing Mesh v1 policy. */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const core = await loadSessionLinkCore();

const { values } = parseArgs({
  options: {
    mode: { type: "string" },
    direction: { type: "string" },
    state: { type: "string" },
    init: { type: "boolean", default: false },
    drain: { type: "boolean", default: false },
    interval: { type: "string", default: "2" },
    timeout: { type: "string", default: "120" },
    "left-agent": { type: "string" },
    "left-session": { type: "string" },
    "left-target": { type: "string" },
    "left-name": { type: "string" },
    "right-agent": { type: "string" },
    "right-session": { type: "string" },
    "right-target": { type: "string" },
    "right-name": { type: "string" },
    "retry-delivery": { type: "string" },
    "drop-delivery": { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (values.help) {
  printHelp();
  process.exit(0);
}

const statePath = required(values.state, "--state");
const interval = positiveNumber(values.interval, "--interval");
const timeout = positiveInteger(values.timeout, "--timeout");
const endpoints = {
  left: endpoint("left"),
  right: endpoint("right"),
};
const config = {
  mode: required(values.mode, "--mode"),
  direction: values.direction,
  left: stripTarget(endpoints.left),
  right: stripTarget(endpoints.right),
};
core.normalizeSessionLinkConfig(config);
validateTargets(config, endpoints);

if (values.init && (values.drain || values["retry-delivery"] || values["drop-delivery"])) {
  fail("--init cannot be combined with drain or delivery recovery actions");
}
if (values["retry-delivery"] && values["drop-delivery"]) {
  fail("choose only one delivery recovery action");
}

const watchBin = process.env.AGENT_LINK_WATCH_BIN || resolve(scriptDir, "agent-watch.py");
const sendBin = process.env.AGENT_LINK_SEND_BIN || resolve(scriptDir, "agent-send.sh");
const cursorPaths = {
  left: `${statePath}.left.cursor.json`,
  right: `${statePath}.right.cursor.json`,
};

if (values.init) {
  if (existsSync(statePath)) fail(`state already exists: ${statePath}`);
  for (const cursor of Object.values(cursorPaths)) {
    if (existsSync(cursor)) fail(`cursor already exists: ${cursor}`);
  }
  for (const side of ["left", "right"]) runWatcher(side, "init");
  saveState(statePath, core.createSessionLinkState(config));
  log({ reason: "session_link_initialized", state: statePath, mode: config.mode, direction: config.direction || "both" });
  process.exit(0);
}

if (!existsSync(statePath)) fail(`state not initialized: run once with --init (${statePath})`);
let state = loadState(statePath);
core.assertSessionLinkState(state, config);

if (values["drop-delivery"]) {
  state = core.acknowledgeSessionLinkDelivery(state, values["drop-delivery"]);
  saveState(statePath, state);
  log({ reason: "delivery_dropped", deliveryId: values["drop-delivery"] });
  process.exit(0);
}

if (values["retry-delivery"]) {
  state = core.retrySessionLinkDelivery(state, values["retry-delivery"]);
  saveState(statePath, state);
  try {
    flushOutbox();
    process.exit(0);
  } catch (error) {
    console.error(`agent-link: ${error.message}`);
    process.exit(1);
  }
}

if (values.drain) {
  try {
    tick();
    process.exit(0);
  } catch (error) {
    console.error(`agent-link: ${error.message}`);
    process.exit(1);
  }
}

while (true) {
  try {
    tick();
  } catch (error) {
    console.error(`agent-link: ${error.message}`);
  }
  await wait(interval * 1000);
}

function tick() {
  flushOutbox();
  for (const side of ["left", "right"]) {
    const events = runWatcher(side, "drain");
    const result = core.processSessionLinkEvents(state, side, events);
    state = result.state;
    for (const item of result.activity) log(item);
  }
  saveState(statePath, state);
  flushOutbox();
}

function flushOutbox() {
  const ambiguous = state.outbox.find((delivery) => ["dispatching", "uncertain"].includes(delivery.status));
  if (ambiguous) {
    throw new Error(
      `delivery ${ambiguous.id} has ambiguous status ${ambiguous.status}; use --retry-delivery or --drop-delivery explicitly`,
    );
  }

  for (const delivery of [...state.outbox]) {
    if (delivery.status !== "pending") continue;
    const target = endpoints[delivery.targetSide];
    state = core.markSessionLinkDeliveryDispatching(state, delivery.id);
    saveState(statePath, state);

    const result = spawnSync(
      sendBin,
      ["--quiet", "--agent", target.agent, target.target, delivery.prompt, String(timeout)],
      { encoding: "utf8", env: process.env },
    );
    if (!result.error && result.status === 0) {
      state = core.acknowledgeSessionLinkDelivery(state, delivery.id);
      saveState(statePath, state);
      log({ reason: "delivery_sent", deliveryId: delivery.id, targetSide: delivery.targetSide });
      continue;
    }

    const detail = result.error?.message || result.stderr || `send command exited ${result.status}`;
    state = core.markSessionLinkDeliveryUncertain(state, delivery.id, detail);
    saveState(statePath, state);
    throw new Error(`delivery ${delivery.id} is uncertain after send failure`);
  }
}

function runWatcher(side, mode) {
  const target = endpoints[side];
  const args = [
    target.sessionId,
    "--agent", target.agent,
    "--state", cursorPaths[side],
    "--format", "jsonl",
    `--${mode}`,
  ];
  const result = spawnSync(watchBin, args, { encoding: "utf8", env: process.env });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr || `watcher exited ${result.status}`;
    throw new Error(`${side} watcher failed: ${String(detail).trim()}`);
  }
  if (mode === "init" || !result.stdout.trim()) return [];
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function endpoint(side) {
  const agent = required(values[`${side}-agent`], `--${side}-agent`);
  const sessionId = required(values[`${side}-session`], `--${side}-session`);
  const other = side === "left" ? "right" : "left";
  const otherAgent = values[`${other}-agent`];
  const defaultName = otherAgent === agent ? `${agent}-${side}` : agent;
  return {
    name: values[`${side}-name`] || defaultName,
    agent,
    sessionId,
    target: values[`${side}-target`] || "",
  };
}

function validateTargets(rawConfig, rawEndpoints) {
  if (rawConfig.mode === "bidirectional") {
    required(rawEndpoints.left.target, "--left-target");
    required(rawEndpoints.right.target, "--right-target");
    return;
  }
  const targetSide = rawConfig.direction === "left-to-right" ? "right" : "left";
  required(rawEndpoints[targetSide].target, `--${targetSide}-target`);
}

function stripTarget(value) {
  return { name: value.name, agent: value.agent, sessionId: value.sessionId };
}

async function loadSessionLinkCore() {
  const candidates = [
    process.env.AGENT_MESH_SESSION_LINK_MODULE,
    resolve(scriptDir, "../../core/src/session-link.js"),
    resolve(scriptDir, "../lib/session-link.js"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    return import(pathToFileURL(candidate).href);
  }
  throw new Error("agent-link: session-link core not found; set AGENT_MESH_SESSION_LINK_MODULE");
}

function loadState(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot read state ${path}: ${error.message}`);
  }
}

function saveState(path, value) {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function required(value, flag) {
  const text = String(value || "").trim();
  if (!text) fail(`${flag} is required`);
  return text;
}

function positiveNumber(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) fail(`${flag} must be greater than zero`);
  return number;
}

function positiveInteger(value, flag) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) fail(`${flag} must be a positive integer`);
  return number;
}

function log(value) {
  console.log(JSON.stringify(value));
}

function fail(message) {
  console.error(`agent-link: ${message}`);
  process.exit(2);
}

function printHelp() {
  console.log(`Usage:
  agent-link.mjs --mode bidirectional --state <FILE> \\
    --left-agent codex --left-session <ID> --left-target <TMUX> \\
    --right-agent claude --right-session <ID> --right-target <TMUX> --init

  agent-link.mjs <same endpoints and state> [--drain]

Modes:
  unidirectional  Requires --direction left-to-right|right-to-left; one wake only.
  bidirectional   Performs one bounded return: A -> B -> A (Mesh hop limit 2).

The watcher buffers messages, reasoning, and tool events. Only turn_complete can
produce one dispatch_once. Use --retry-delivery or --drop-delivery to resolve a
delivery left uncertain by an interrupted or failed send.`);
}
