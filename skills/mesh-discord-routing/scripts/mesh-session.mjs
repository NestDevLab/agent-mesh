#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultStateDir = resolve(skillDir, "state");
const policies = new Set([
  "round_robin",
  "facilitator_selected",
  "participant_selected",
  "random",
  "broadcast",
  "freeform"
]);

function readArgs(name) {
  const values = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === name) {
      const value = process.argv[index + 1];
      if (value && !value.startsWith("--")) {
        values.push(value);
        index += 1;
      }
      continue;
    }
    if (arg.startsWith(`${name}=`)) values.push(arg.slice(name.length + 1));
  }
  return values;
}

function readArg(name, fallback = "") {
  return readArgs(name).at(-1) || fallback;
}

function labelsFrom(values) {
  return values
    .join(",")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function unique(values) {
  return [...new Set(values)];
}

function fail(message, code = 2) {
  console.error(`mesh-session: ${message}`);
  process.exit(code);
}

function nowCompact() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function statePathFor(sessionId, stateDir) {
  return resolve(stateDir, `${sessionId}.json`);
}

function loadState(path) {
  if (!existsSync(path)) fail(`state file not found: ${path}`, 4);
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function ensureParticipant(state, label, field) {
  if (!label) return;
  if (!state.participants.includes(label)) {
    fail(`${field} must be one of participants: ${state.participants.join(", ")}`, 3);
  }
}

function nextRoundRobin(state, from) {
  const current = from || state.activeParticipant || state.participants[0];
  const index = Math.max(0, state.participants.indexOf(current));
  return [state.participants[(index + 1) % state.participants.length]];
}

function nextRandom(state, from) {
  const candidates = state.participants.filter((label) => label !== from);
  const pool = candidates.length > 0 ? candidates : state.participants;
  return [pool[Math.floor(Math.random() * pool.length)]];
}

function assertNoAccidentalLoop(state, recipients, allowSame) {
  if (allowSame || state.participants.length < 2 || recipients.length !== 1) return;
  const previous = state.activeParticipant;
  if (previous && recipients[0] === previous) {
    fail(`anti-loop blocked repeated active participant: ${previous}`, 5);
  }
}

function start() {
  const participants = unique(labelsFrom(readArgs("--participants").concat(readArgs("--participant"))));
  if (participants.length === 0) fail("missing --participants");

  const policy = readArg("--policy", "round_robin");
  if (!policies.has(policy)) fail(`unknown policy: ${policy}`);

  const stateDir = resolve(readArg("--state-dir", defaultStateDir));
  const channelId = readArg("--channel-id", "local");
  const sessionId = readArg("--session-id", `mesh-${nowCompact()}-${channelId}`);
  const activeParticipant = readArg("--active", participants[0]).toLowerCase();
  ensureParticipant({ participants }, activeParticipant, "--active");

  const state = {
    schemaVersion: 1,
    sessionId,
    channelId,
    skill: readArg("--skill", ""),
    participants,
    turnPolicy: policy,
    activeParticipant,
    allowSameParticipant: readArg("--allow-same", "false") === "true",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    history: []
  };
  const path = statePathFor(sessionId, stateDir);
  saveState(path, state);
  console.log(JSON.stringify({ statePath: path, activeParticipant, to: [activeParticipant] }, null, 2));
}

function next() {
  const stateArg = readArg("--state");
  if (!stateArg) fail("missing --state");
  const path = resolve(stateArg);
  const state = loadState(path);
  if (state.status && state.status !== "active") fail(`session is not active: ${state.status}`, 6);

  const from = readArg("--from", state.activeParticipant).toLowerCase();
  ensureParticipant(state, from, "--from");

  const selected = unique(labelsFrom(readArgs("--selected").concat(readArgs("--to"))));
  for (const label of selected) ensureParticipant(state, label, "--selected/--to");

  let recipients = [];
  switch (state.turnPolicy) {
    case "round_robin":
      recipients = nextRoundRobin(state, from);
      break;
    case "facilitator_selected":
    case "participant_selected":
      if (selected.length === 0) fail(`${state.turnPolicy} requires --selected or --to`);
      recipients = selected;
      break;
    case "random":
      recipients = selected.length > 0 ? selected : nextRandom(state, from);
      break;
    case "broadcast":
      recipients = selected.length > 0 ? selected : state.participants.filter((label) => label !== from);
      break;
    case "freeform":
      recipients = selected;
      break;
    default:
      fail(`unknown policy: ${state.turnPolicy}`);
  }

  assertNoAccidentalLoop(state, recipients, Boolean(state.allowSameParticipant));

  state.history.push({
    at: new Date().toISOString(),
    from,
    to: recipients,
    policy: state.turnPolicy,
    reason: readArg("--reason", "")
  });
  state.activeParticipant = recipients.length === 1 ? recipients[0] : null;
  state.updatedAt = new Date().toISOString();
  saveState(path, state);
  console.log(JSON.stringify({ statePath: path, activeParticipant: state.activeParticipant, to: recipients }, null, 2));
}

function show() {
  const stateArg = readArg("--state");
  if (!stateArg) fail("missing --state");
  const path = resolve(stateArg);
  console.log(JSON.stringify(loadState(path), null, 2));
}

const command = process.argv[2];
if (command === "start") start();
else if (command === "next") next();
else if (command === "show") show();
else fail("usage: mesh-session.mjs start|next|show ...");
