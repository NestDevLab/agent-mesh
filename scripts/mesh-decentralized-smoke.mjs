#!/usr/bin/env node
import { formatMeshV1Envelope, planMeshV1Dispatch } from "../packages/core/src/policy.js";

const participants = ["alpha", "beta", "gamma"];
const states = Object.fromEntries(participants.map((participant) => [participant, { records: {} }]));
const transcript = [];
let messageCounter = 0;

function deliver(participant, envelope) {
  messageCounter += 1;
  const plan = planMeshV1Dispatch(
    { localParticipant: participant },
    { text: envelope, state: states[participant], messageId: `decentralized-${messageCounter}` }
  );
  if (plan.stateTransition) states[participant] = plan.stateTransition;
  transcript.push({
    participant,
    meshId: plan.envelope?.meshId,
    from: plan.envelope?.from,
    turn: plan.envelope?.turn,
    reason: plan.reason,
    nextAction: plan.nextAction,
    dispatchText: plan.dispatchText
  });
  return plan;
}

function envelope(fields) {
  return formatMeshV1Envelope(fields);
}

const betaPartial = envelope({
  to: ["beta"],
  from: "alpha",
  meshId: "complex-peer-run/alpha-beta",
  turn: "beta",
  final: false,
  seen: ["alpha"],
  hopLimit: 4,
  body: "Alpha asks Beta to inspect protocol ownership."
});
const betaFinal = envelope({
  to: ["beta"],
  from: "alpha",
  meshId: "complex-peer-run/alpha-beta",
  turn: "beta",
  final: true,
  seen: ["alpha"],
  hopLimit: 4,
  body: "Beta should answer only with blockers and route onward if needed."
});

assertPlan(deliver("beta", betaPartial), "mesh_v1_partial_buffered", "buffer_only");
const betaDispatch = deliver("beta", betaFinal);
assertPlan(betaDispatch, "mesh_v1_final_dispatch_ready", "dispatch_once");
assertPlan(deliver("beta", betaFinal), "mesh_v1_duplicate_suppressed", "none");

assertPlan(deliver("gamma", envelope({
  to: ["gamma"],
  from: "beta",
  meshId: "complex-peer-run/beta-gamma",
  turn: "gamma",
  final: true,
  seen: ["alpha", "beta"],
  hopLimit: 3,
  body: "Beta found no ownership blocker. Gamma should check loops and transport fanout."
})), "mesh_v1_final_dispatch_ready", "dispatch_once");

assertPlan(deliver("gamma", envelope({
  to: ["gamma"],
  from: "alpha",
  meshId: "complex-peer-run/alpha-gamma",
  turn: "gamma",
  final: true,
  seen: ["alpha"],
  hopLimit: 4,
  body: "Alpha independently asks Gamma for transport risks."
})), "mesh_v1_final_dispatch_ready", "dispatch_once");

assertPlan(deliver("alpha", envelope({
  to: ["alpha"],
  from: "gamma",
  meshId: "complex-peer-run/gamma-alpha",
  turn: "alpha",
  final: true,
  seen: ["beta", "gamma"],
  hopLimit: 2,
  body: "Gamma synthesized both peer branches. Alpha can produce the final human summary."
})), "mesh_v1_final_dispatch_ready", "dispatch_once");

assertPlan(deliver("alpha", envelope({
  to: ["alpha"],
  from: "gamma",
  meshId: "complex-peer-run/wrong-turn",
  turn: "beta",
  final: true,
  body: "Alpha is addressed but Beta owns this semantic turn."
})), "mesh_v1_not_local_turn", "none");

assertPlan(deliver("alpha", envelope({
  to: ["alpha"],
  from: "gamma",
  meshId: "complex-peer-run/seen-loop",
  turn: "alpha",
  final: true,
  seen: ["alpha", "gamma"],
  hopLimit: 2,
  body: "Loop attempt that Alpha has already seen."
})), "mesh_v1_loop_guard_seen", "none");

const dispatches = transcript.filter((entry) => entry.nextAction === "dispatch_once");
if (dispatches.length !== 4) {
  throw new Error(`expected 4 dispatch_once decisions, got ${dispatches.length}`);
}

console.log("PASS decentralized mesh peer smoke");
for (const entry of transcript) {
  console.log(JSON.stringify(entry));
}

function assertPlan(plan, reason, nextAction) {
  if (plan.reason !== reason || plan.nextAction !== nextAction) {
    throw new Error(`expected ${reason}/${nextAction}, got ${plan.reason}/${plan.nextAction}`);
  }
}
