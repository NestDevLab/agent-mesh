import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const { MemoryFabricPolicyGate } = await import("../src/core/memory-fabric-policy.ts");
const { MemoryFabricStore } = await import("../src/core/memory-fabric-store.ts");
const { validateMemoryFabricPolicyEvaluation } = await import("../src/schema/memory-fabric.ts");

const fixedClock = {
  now() {
    return new Date("2026-05-10T08:00:00.000Z");
  }
};

test("Memory Fabric policy denies unscoped proposals", async () => {
  const { evaluation } = await evaluate({ scope: null });

  assert.equal(evaluation.decision.decision, "deny");
  assert.equal(evaluation.decision.status, "denied_stubbed");
  assert.match(evaluation.decision.reason, /unscoped/);
  assert.equal(evaluation.decision.no_external_write, true);
});

test("Memory Fabric policy denies unknown targets and scopes", async () => {
  const unknownTarget = await evaluate({ target: "real_mem0_adapter" });
  const unknownScope = await evaluate({ scope: "domain.unknown" });

  assert.equal(unknownTarget.evaluation.decision.decision, "deny");
  assert.equal(unknownTarget.evaluation.decision.status, "denied_stubbed");
  assert.equal(unknownTarget.evaluation.decision.risk_flags.includes("unknown-target"), true);
  assert.equal(unknownScope.evaluation.decision.decision, "deny");
  assert.equal(unknownScope.evaluation.decision.risk_flags.includes("unknown-scope"), true);
});

test("Memory Fabric policy denies unredacted secret content", async () => {
  const explicitSecret = await evaluate({
    sensitivity: "secret",
    redaction_state: "none",
    content: { text: "sensitive operational detail" }
  });
  const secretShape = await evaluate({
    content: { api_key: "x" }
  });

  assert.equal(explicitSecret.evaluation.decision.decision, "deny");
  assert.equal(explicitSecret.evaluation.decision.risk_flags.includes("secret-unredacted"), true);
  assert.equal(secretShape.evaluation.decision.decision, "deny");
  assert.equal(
    secretShape.evaluation.decision.risk_flags.includes("obvious-secret-shaped-field"),
    true
  );
});

test("Memory Fabric policy allows same-domain low-sensitivity proposals once", async () => {
  const { evaluation, stateDir } = await evaluate({
    target: "mem0_scope",
    operation: "propose_write",
    scope: "domain.nestdev",
    sensitivity: "internal"
  });

  assert.equal(evaluation.decision.decision, "allow-once");
  assert.equal(evaluation.decision.status, "approved_stubbed");
  assert.equal(evaluation.decision.human_escalation_required, false);
  assert.equal(evaluation.decision.metadata.target_write_stubbed, true);

  const events = await new MemoryFabricStore({ stateDir, clock: fixedClock }).replay();
  assert.equal(events.records.length, 1);
  assert.equal(events.records[0].event_type, "memory.proposal.allowed_stubbed");
});

test("Memory Fabric policy asks human for durable shared writes", async () => {
  const { evaluation } = await evaluate({
    target: "memory_wiki",
    operation: "commit_write",
    scope: "domain.nestdev",
    sensitivity: "internal"
  });

  assert.equal(evaluation.decision.decision, "ask-human");
  assert.equal(evaluation.decision.status, "requires_human_stubbed");
  assert.equal(evaluation.decision.human_escalation_required, true);
  assert.equal(evaluation.decision.risk_flags.includes("durable-shared-write"), true);
});

test("Memory Fabric policy asks human for delete and forget requests", async () => {
  const { evaluation } = await evaluate({
    target: "memory_wiki",
    operation: "delete_request",
    scope: "domain.nestdev",
    sensitivity: "internal"
  });

  assert.equal(evaluation.decision.decision, "ask-human");
  assert.equal(evaluation.decision.status, "requires_human_stubbed");
  assert.equal(evaluation.decision.risk_flags.includes("delete-forget-request"), true);
});

test("Memory Fabric schemas validate policy evaluations", async () => {
  const { evaluation } = await evaluate();
  const result = validateMemoryFabricPolicyEvaluation(evaluation);

  assert.equal(result.ok, true);
  assert.equal(result.value.proposal.no_external_write, true);
  assert.equal(result.value.decision.no_external_write, true);
});

async function evaluate(overrides = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "agent-mesh-memory-fabric-"));
  const gate = new MemoryFabricPolicyGate({
    stateDir,
    clock: fixedClock,
    agentDomainAccess: {
      "agent.software_engineer": ["domain.nestdev"]
    }
  });
  const evaluation = await gate.evaluate(proposal(overrides));
  return { evaluation, stateDir };
}

function proposal(overrides = {}) {
  return {
    id: "memory_proposal_1",
    requested_by_agent_id: "agent.software_engineer",
    workspace_id: "workspace.joseph",
    domain_id: "domain.nestdev",
    project_id: "project.agent_mesh",
    target: "mem0_scope",
    operation: "propose_write",
    scope: "domain.nestdev",
    sensitivity: "internal",
    redaction_state: "none",
    provenance: {
      source_kind: "conversation",
      source_id: "conversation-1"
    },
    content: { summary: "Record a low-sensitivity project fact." },
    policy_profile: "memory_fabric_phase_2_stub",
    created_at: "2026-05-10T07:59:00.000Z",
    no_external_write: true,
    metadata: { source: "test" },
    ...overrides
  };
}
