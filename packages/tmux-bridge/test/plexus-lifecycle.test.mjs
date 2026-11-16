import assert from "node:assert/strict";
import test from "node:test";
import { applyPlexusEvent, LIFECYCLE_EVENTS, PLEXUS_EVENTS } from "../bin/plexus.mjs";

const session = "codex:11111111-1111-4111-8111-111111111111";
const state = () => ({ nodes: new Map(), links: new Map(), edges: new Map(), renewals: [] });

test("lifecycle evidence is replayable without mutating session ownership", () => {
  for (const type of LIFECYCLE_EVENTS) {
    const graph = state();
    assert.ok(PLEXUS_EVENTS.has(type));
    const extra = type === "session.handover" ? { to: "claude:33333333-3333-4333-8333-333333333333" } : {};
    assert.deepEqual(applyPlexusEvent(graph, { type, session, evidence: "source:example", ...extra }), [{ kind: type, session, evidence: "source:example", ...extra }]);
    assert.equal(graph.nodes.size, 0);
    assert.equal(graph.links.size, 0);
  }
});

test("lifecycle events reject missing evidence and malformed identities", () => {
  assert.throws(() => applyPlexusEvent(state(), { type: "session.idle", session }), /evidence/);
  assert.throws(() => applyPlexusEvent(state(), { type: "session.started", session: "codex:bad", evidence: "source:example" }), /session/);
  assert.throws(() => applyPlexusEvent(state(), { type: "session.stopped", session, evidence: "one\ntwo" }), /evidence/);
});
