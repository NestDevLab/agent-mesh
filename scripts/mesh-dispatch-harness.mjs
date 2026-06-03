#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { planMeshV1Dispatch } from "../packages/core/src/policy.js";

const { values } = parseArgs({
  options: {
    participant: { type: "string", short: "p" },
    "state-file": { type: "string", short: "s" },
    "message-id-prefix": { type: "string", default: "harness" },
    pretty: { type: "boolean", default: false },
    help: { type: "boolean", default: false }
  }
});

if (values.help || !values.participant) {
  console.error(`Usage: npm run mesh:harness -- --participant <label> [--state-file state.json] < messages.txt\n\nMessages are separated by a line containing exactly ---mesh-message---.`);
  process.exit(values.help ? 0 : 2);
}

function readState(path) {
  if (!path || !existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeState(path, state) {
  if (path) writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

const input = readFileSync(0, "utf8");
const messages = input
  .split(/^---mesh-message---\s*$/m)
  .map((message) => message.trimStart().replace(/\s+$/u, ""))
  .filter(Boolean);

let state = readState(values["state-file"]);
const results = [];

for (const [index, text] of messages.entries()) {
  const plan = planMeshV1Dispatch(
    { localParticipant: values.participant },
    { messageId: `${values["message-id-prefix"]}-${index + 1}`, text, state }
  );
  if (plan.stateTransition) state = plan.stateTransition;
  const result = {
    index: index + 1,
    reason: plan.reason,
    nextAction: plan.nextAction,
    accepted: plan.accepted,
    dispatchText: plan.dispatchText,
    stateRecordCount: Object.keys(plan.stateTransition?.records ?? state?.records ?? {}).length,
    envelope: plan.envelope ? {
      valid: plan.envelope.valid,
      errors: plan.envelope.errors,
      meshId: plan.envelope.meshId,
      from: plan.envelope.from,
      turn: plan.envelope.turn,
      final: plan.envelope.final
    } : undefined
  };
  results.push(result);
}

writeState(values["state-file"], state ?? { records: {} });

for (const result of results) {
  console.log(values.pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result));
}
