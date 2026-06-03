import test from "node:test";
import assert from "node:assert/strict";
import {
  formatMeshV1Envelope,
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
