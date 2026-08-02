import test from "node:test";
import assert from "node:assert/strict";
import {
  acknowledgeSessionLinkDelivery,
  createSessionLinkState,
  markSessionLinkDeliveryDispatching,
  markSessionLinkDeliveryUncertain,
  processSessionLinkEvents,
  retrySessionLinkDelivery,
} from "../src/session-link.js";
import { parseMeshV1Envelope } from "../src/policy.js";

const config = {
  mode: "bidirectional",
  left: { name: "codex", agent: "codex", sessionId: "codex-session" },
  right: { name: "claude", agent: "claude", sessionId: "claude-session" },
};

function event(kind, id, extra = {}) {
  return {
    timestamp: "2026-08-02T12:00:00Z",
    agent: extra.agent || "codex",
    session_id: extra.session_id || "session",
    kind,
    body: extra.body || "",
    phase: extra.phase,
    tool_name: extra.tool_name,
    source_event_id: id,
  };
}

test("bidirectional session link performs one bounded return turn", () => {
  let state = createSessionLinkState(config);
  let result = processSessionLinkEvents(state, "left", [
    event("human_message", "left-user", { body: "question" }),
    event("reasoning", "left-think", { body: "considering" }),
    event("tool", "left-tool", { body: "{}", tool_name: "shell" }),
    event("agent_message", "left-final", { body: "left answer", phase: "final" }),
    event("turn_complete", "left-complete"),
  ]);
  state = result.state;
  assert.equal(state.outbox.length, 1);
  assert.equal(state.outbox[0].targetSide, "right");
  let envelope = parseMeshV1Envelope(state.outbox[0].prompt);
  assert.equal(envelope.valid, true);
  assert.equal(envelope.turn, "claude");
  assert.equal(envelope.hopLimit, 2);
  assert.deepEqual(envelope.seen, []);
  assert.match(envelope.body, /\[human\] question/);
  assert.match(envelope.body, /\[codex\/reasoning\] considering/);
  assert.match(envelope.body, /\[tool:shell\]/);
  const meshId = envelope.meshId;

  state = acknowledgeSessionLinkDelivery(state, state.outbox[0].id);
  result = processSessionLinkEvents(state, "right", [
    event("human_message", "right-relay", { agent: "claude", body: statePrompt(meshId, "codex", "claude", 2, []) }),
    event("reasoning", "right-think", { agent: "claude", body: "reviewing" }),
    event("agent_message", "right-final", { agent: "claude", body: "claude answer", phase: "final" }),
    event("turn_complete", "right-complete", { agent: "claude" }),
  ]);
  state = result.state;
  assert.equal(state.outbox.length, 1);
  assert.equal(state.outbox[0].targetSide, "left");
  envelope = parseMeshV1Envelope(state.outbox[0].prompt);
  assert.equal(envelope.meshId, meshId);
  assert.equal(envelope.turn, "codex");
  assert.equal(envelope.hopLimit, 1);
  assert.deepEqual(envelope.seen, ["claude"]);
  assert.doesNotMatch(envelope.body, /original relay body/);
  assert.match(envelope.body, /claude answer/);

  const returnPrompt = state.outbox[0].prompt;
  state = acknowledgeSessionLinkDelivery(state, state.outbox[0].id);
  result = processSessionLinkEvents(state, "left", [
    event("human_message", "left-return", { body: returnPrompt }),
    event("agent_message", "left-integrated", { body: "integrated", phase: "final" }),
    event("turn_complete", "left-return-complete"),
  ]);
  assert.equal(result.state.outbox.length, 0);
  assert.ok(result.activity.some((item) => item.reason === "hop_limit_exhausted"));
});

test("unidirectional session link never returns the target response", () => {
  const oneWay = {
    ...config,
    mode: "unidirectional",
    direction: "left-to-right",
  };
  let state = createSessionLinkState(oneWay);
  let result = processSessionLinkEvents(state, "right", [
    event("human_message", "right-human", { agent: "claude", body: "local target question" }),
    event("turn_complete", "right-local-complete", { agent: "claude" }),
  ]);
  assert.equal(result.state.outbox.length, 0);
  assert.ok(result.activity.some((item) => item.reason === "direction_not_enabled"));

  result = processSessionLinkEvents(result.state, "left", [
    event("human_message", "left-human", { body: "source question" }),
    event("agent_message", "left-answer", { body: "source answer", phase: "final" }),
    event("turn_complete", "left-done"),
  ]);
  state = result.state;
  assert.equal(state.outbox.length, 1);
  const first = parseMeshV1Envelope(state.outbox[0].prompt);
  assert.equal(first.hopLimit, 1);
  state = acknowledgeSessionLinkDelivery(state, state.outbox[0].id);

  result = processSessionLinkEvents(state, "right", [
    event("human_message", "right-inbound", { agent: "claude", body: statePrompt(first.meshId, "codex", "claude", 1, []) }),
    event("agent_message", "right-answer", { agent: "claude", body: "target answer", phase: "final" }),
    event("turn_complete", "right-done", { agent: "claude" }),
  ]);
  assert.equal(result.state.outbox.length, 0);
  assert.ok(result.activity.some((item) => item.reason === "hop_limit_exhausted"));
});

test("session link buffers until turn_complete and suppresses replay", () => {
  let state = createSessionLinkState(config);
  const partial = [
    event("human_message", "same-user", { body: "question" }),
    event("agent_message", "same-answer", { body: "answer", phase: "final" }),
  ];
  let result = processSessionLinkEvents(state, "left", partial);
  assert.equal(result.state.outbox.length, 0);
  result = processSessionLinkEvents(result.state, "left", [event("turn_complete", "same-complete")]);
  state = result.state;
  assert.equal(state.outbox.length, 1);
  state = acknowledgeSessionLinkDelivery(state, state.outbox[0].id);

  result = processSessionLinkEvents(state, "left", [...partial, event("turn_complete", "same-complete")]);
  assert.equal(result.state.outbox.length, 0);
  assert.ok(result.activity.some((item) => item.reason === "mesh_v1_duplicate_suppressed"));
});

test("foreign Mesh envelopes are not amplified", () => {
  const state = createSessionLinkState(config);
  for (const [label, meshId] of [["foreign", "foreign"], ["forged", `${state.linkPrefix}forged`]]) {
    const prompt = `ccm:v1 id=${meshId} from=other turn=codex final=1 hop=4\n\nforeign message`;
    const result = processSessionLinkEvents(state, "left", [
      event("human_message", `${label}-user`, { body: prompt }),
      event("agent_message", `${label}-answer`, { body: "answer", phase: "final" }),
      event("turn_complete", `${label}-complete`),
    ]);
    assert.equal(result.state.outbox.length, 0);
    assert.ok(result.activity.some((item) => item.reason === "foreign_mesh_not_relayed"));
  }
});

test("durable outbox requires explicit recovery after an uncertain send", () => {
  let state = createSessionLinkState(config);
  state = processSessionLinkEvents(state, "left", [
    event("human_message", "recovery-user", { body: "question" }),
    event("turn_complete", "recovery-complete"),
  ]).state;
  const deliveryId = state.outbox[0].id;
  state = markSessionLinkDeliveryDispatching(state, deliveryId);
  assert.equal(state.outbox[0].status, "dispatching");
  assert.equal(state.outbox[0].attempts, 1);
  state = markSessionLinkDeliveryUncertain(state, deliveryId, "timeout");
  assert.equal(state.outbox[0].status, "uncertain");
  state = retrySessionLinkDelivery(state, deliveryId);
  assert.equal(state.outbox[0].status, "pending");
  state = acknowledgeSessionLinkDelivery(state, deliveryId);
  assert.equal(state.outbox.length, 0);
});

function statePrompt(meshId, from, turn, hop, seen) {
  const seenField = seen.length ? ` seen=${seen.join(",")}` : "";
  return `ccm:v1 id=${meshId} from=${from} turn=${turn} final=1${seenField} hop=${hop}\n\noriginal relay body`;
}
