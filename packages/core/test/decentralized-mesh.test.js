import test from "node:test";
import assert from "node:assert/strict";
import {
  formatCompactMeshV1Envelope,
  formatMeshV1Envelope,
  parseMeshV1Envelope,
  planMeshV1Dispatch
} from "../src/policy.js";

function processMessage(participant, text, state, messageId) {
  const plan = planMeshV1Dispatch(
    { localParticipant: participant },
    { text, state, messageId }
  );
  return {
    plan,
    state: plan.stateTransition ?? state
  };
}

test("decentralized peer mesh supports branching peer-to-peer turns without a coordinator", () => {
  const states = {
    alpha: { records: {} },
    beta: { records: {} },
    gamma: { records: {} }
  };

  const alphaToBetaPartial = formatMeshV1Envelope({
    to: ["beta"],
    from: "alpha",
    meshId: "mesh-decentralized-1",
    turn: "beta",
    final: false,
    seen: ["alpha"],
    hopLimit: 4,
    body: "alpha asks beta to inspect parser ownership"
  });
  const alphaToBetaFinal = formatMeshV1Envelope({
    to: ["beta"],
    from: "alpha",
    meshId: "mesh-decentralized-1",
    turn: "beta",
    final: true,
    seen: ["alpha"],
    hopLimit: 4,
    body: "alpha asks beta to report only risks"
  });

  let result = processMessage("beta", alphaToBetaPartial, states.beta, "m1");
  states.beta = result.state;
  assert.equal(result.plan.reason, "mesh_v1_partial_buffered");
  assert.equal(result.plan.nextAction, "buffer_only");

  result = processMessage("beta", alphaToBetaFinal, states.beta, "m2");
  states.beta = result.state;
  assert.equal(result.plan.reason, "mesh_v1_final_dispatch_ready");
  assert.equal(result.plan.nextAction, "dispatch_once");
  assert.equal(result.plan.dispatchText, "alpha asks beta to inspect parser ownership\nalpha asks beta to report only risks");

  const duplicate = processMessage("beta", alphaToBetaFinal, states.beta, "m2");
  assert.equal(duplicate.plan.reason, "mesh_v1_duplicate_suppressed");
  assert.equal(duplicate.plan.nextAction, "none");

  const betaToGamma = formatMeshV1Envelope({
    to: ["gamma"],
    from: "beta",
    meshId: "mesh-decentralized-1/beta-risk",
    turn: "gamma",
    final: true,
    seen: ["alpha", "beta"],
    hopLimit: 3,
    body: "beta found no parser blocker; gamma should check loop safety"
  });
  result = processMessage("gamma", betaToGamma, states.gamma, "m3");
  states.gamma = result.state;
  assert.equal(result.plan.reason, "mesh_v1_final_dispatch_ready");
  assert.equal(result.plan.dispatchText, "beta found no parser blocker; gamma should check loop safety");

  const alphaToGamma = formatMeshV1Envelope({
    to: ["gamma"],
    from: "alpha",
    meshId: "mesh-decentralized-1/alpha-direct",
    turn: "gamma",
    final: true,
    seen: ["alpha"],
    hopLimit: 4,
    body: "alpha independently asks gamma for transport risks"
  });
  result = processMessage("gamma", alphaToGamma, states.gamma, "m4");
  states.gamma = result.state;
  assert.equal(result.plan.reason, "mesh_v1_final_dispatch_ready");

  const gammaToAlpha = formatMeshV1Envelope({
    to: ["alpha"],
    from: "gamma",
    meshId: "mesh-decentralized-1/gamma-synthesis",
    turn: "alpha",
    final: true,
    seen: ["beta", "gamma"],
    hopLimit: 2,
    body: "gamma synthesized beta and alpha branches; ready for human-visible summary"
  });
  result = processMessage("alpha", gammaToAlpha, states.alpha, "m5");
  states.alpha = result.state;
  assert.equal(result.plan.reason, "mesh_v1_final_dispatch_ready");
  assert.equal(result.plan.nextAction, "dispatch_once");

  const wrongTurn = formatMeshV1Envelope({
    to: ["alpha"],
    from: "gamma",
    meshId: "mesh-decentralized-1/wrong-turn",
    turn: "beta",
    final: true,
    body: "this names alpha as recipient but beta as the semantic turn"
  });
  assert.equal(processMessage("alpha", wrongTurn, states.alpha, "m6").plan.reason, "mesh_v1_not_local_turn");

  const loop = formatMeshV1Envelope({
    to: ["alpha"],
    from: "gamma",
    meshId: "mesh-decentralized-1/loop",
    turn: "alpha",
    final: true,
    seen: ["alpha", "gamma"],
    hopLimit: 2,
    body: "alpha has already seen this path"
  });
  assert.equal(processMessage("alpha", loop, states.alpha, "m7").plan.reason, "mesh_v1_loop_guard_seen");
});

test("mesh envelope formatter emits parseable headers and validates destination turn", () => {
  const text = formatMeshV1Envelope({
    to: "beta,gamma",
    from: "alpha",
    meshId: "formatter-1",
    turn: "gamma",
    final: true,
    seen: "alpha beta",
    hopLimit: 1,
    body: "hello peers"
  });

  const gamma = processMessage("gamma", text, { records: {} }, "fmt-1");
  assert.equal(gamma.plan.reason, "mesh_v1_final_dispatch_ready");
  assert.equal(gamma.plan.dispatchText, "hello peers");

  const beta = processMessage("beta", text, { records: {} }, "fmt-1-beta");
  assert.equal(beta.plan.reason, "mesh_v1_not_local_turn");
});

test("compact ccm:v1 envelope parses after Discord mention and dispatches like legacy headers", () => {
  const text = `<@222>\nccm:v1 id=compact-1 from=alpha turn=beta final=1 seen=alpha hop=3\n\ncompact body`;
  const envelope = parseMeshV1Envelope(text);

  assert.equal(envelope.valid, true);
  assert.equal(envelope.format, "ccm:v1");
  assert.deepEqual(envelope.to, ["beta"]);
  assert.equal(envelope.from, "alpha");
  assert.equal(envelope.meshId, "compact-1");
  assert.equal(envelope.turn, "beta");
  assert.equal(envelope.final, true);
  assert.deepEqual(envelope.seen, ["alpha"]);
  assert.equal(envelope.hopLimit, 3);
  assert.equal(envelope.body, "compact body");

  const beta = processMessage("beta", text, { records: {} }, "compact-msg-1");
  assert.equal(beta.plan.reason, "mesh_v1_final_dispatch_ready");
  assert.equal(beta.plan.dispatchText, "compact body");
});

test("compact formatter hydrates display labels to raw wake mention", () => {
  const text = formatCompactMeshV1Envelope({
    from: "runtime-a-openclaw",
    meshId: "compact-hydrate-1",
    turn: "runtime-a - NestDev",
    final: true,
    seen: ["runtime-b", "runtime-a-openclaw"],
    hopLimit: 3,
    participants: [
      { botId: "222", mention: "<@222>", label: "nestdev", aliases: ["runtime-a - NestDev"] }
    ],
    body: "handoff"
  });

  assert.match(text, /^<@222>\nccm:v1 /);
  assert.doesNotMatch(text.split("\n")[0], /runtime-a - NestDev/);
  assert.match(text, / turn=nestdev /);

  const envelope = parseMeshV1Envelope(text);
  assert.equal(envelope.valid, true);
  assert.equal(envelope.turn, "nestdev");
  assert.deepEqual(envelope.to, ["nestdev"]);

  const nestdev = processMessage("nestdev", text, { records: {} }, "compact-hydrate-1");
  assert.equal(nestdev.plan.reason, "mesh_v1_final_dispatch_ready");
  assert.equal(nestdev.plan.dispatchText, "handoff");
});

test("compact formatter emits one ccm:v1 line and supports partial/final dedupe", () => {
  let state = { records: {} };
  const partial = formatCompactMeshV1Envelope({
    from: "alpha",
    meshId: "compact-2",
    turn: "beta",
    final: false,
    seen: ["alpha"],
    hopLimit: 3,
    body: "part one"
  });
  const final = formatCompactMeshV1Envelope({
    from: "alpha",
    meshId: "compact-2",
    turn: "beta",
    final: true,
    seen: ["alpha"],
    hopLimit: 3,
    body: "part two"
  });

  assert.match(partial, /^ccm:v1 id=compact-2 from=alpha turn=beta final=0 seen=alpha hop=3\n\npart one$/);

  let result = processMessage("beta", partial, state, "compact-2-p");
  state = result.state;
  assert.equal(result.plan.reason, "mesh_v1_partial_buffered");
  assert.equal(result.plan.nextAction, "buffer_only");

  result = processMessage("beta", final, state, "compact-2-f");
  state = result.state;
  assert.equal(result.plan.reason, "mesh_v1_final_dispatch_ready");
  assert.equal(result.plan.dispatchText, "part one\npart two");

  const duplicate = processMessage("beta", final, state, "compact-2-f");
  assert.equal(duplicate.plan.reason, "mesh_v1_duplicate_suppressed");
});
