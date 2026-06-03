import assert from "node:assert/strict";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const {
  deriveMeshRoutePolicyConcept,
  describeCorrelationSemantics,
  mapEnvelopeToBridgeAlignedView
} = await import("../src/core/bridge-alignment.ts");
const { GatewayService } = await import("../src/core/gateway-service.ts");
const { AgentRegistry } = await import("../src/core/agent-registry.ts");
const { ContextRegistry } = await import("../src/core/context-registry.ts");
const { mkdtemp } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

const fixedClock = {
  now() {
    return new Date("2026-05-09T12:00:00.000Z");
  }
};

test("maps mesh envelopes to the bridge request-envelope vocabulary", () => {
  const mapped = mapEnvelopeToBridgeAlignedView(envelope());

  assert.equal(mapped.schema, "openclaw.agent_mesh.bridge_alignment.v1");
  assert.equal(mapped.layer_role, "agent_orchestration_mesh");
  assert.equal(mapped.request_id, "msg-request-1");
  assert.equal(mapped.correlation_id, "corr-1");
  assert.equal(mapped.reply_to_request_id, null);
  assert.equal(mapped.mode, "request");
  assert.equal(mapped.source, "agent.chief_of_staff");
  assert.equal(mapped.destination, "agent.software_engineer");
  assert.equal(mapped.operation, "agent_mesh.request");
  assert.equal(mapped.idempotency_key, "idem-request-1");
  assert.equal(mapped.metadata.domain_id, "domain.nestdev");
  assert.equal(mapped.reused_bridge_patterns.includes("adapter_delivery"), true);
});

test("describes route policy as local orchestration, not live bridge delivery", () => {
  const routePolicy = deriveMeshRoutePolicyConcept(envelope());

  assert.equal(routePolicy.route_family, "agent_orchestration");
  assert.equal(routePolicy.boundary, "package_local_stub");
  assert.equal(routePolicy.opens_reply_window, true);
  assert.equal(routePolicy.requires_reply_parent, false);
  assert.equal(routePolicy.delivery_contract, "async_lifecycle");
  assert.equal(routePolicy.external_side_effects_allowed, false);
});

test("correlation semantics expose missing reply parent without rejecting", () => {
  const reply = envelope({
    message_id: "msg-reply-1",
    idempotency_key: "idem-reply-1",
    from: "agent.software_engineer",
    to: "agent.chief_of_staff",
    intent: "reply",
    correlation_id: "corr-1",
    causation_id: "msg-request-1"
  });

  const semantics = describeCorrelationSemantics(reply);
  assert.equal(semantics.is_reply, true);
  assert.equal(semantics.reply_to_request_id, "msg-request-1");
  assert.deepEqual(semantics.issues, []);

  const parentless = describeCorrelationSemantics({
    ...reply,
    message_id: "msg-parentless-reply",
    causation_id: null
  });
  assert.deepEqual(parentless.issues, ["reply_missing_parent_reference"]);
});

test("accepted audit includes bridge-aligned mapping details", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agent-mesh-bridge-alignment-"));
  const gateway = new GatewayService({
    stateDir,
    clock: fixedClock,
    contextRegistry: new ContextRegistry(contexts()),
    agentRegistry: new AgentRegistry(agents())
  });

  await gateway.submitEnvelope(envelope());
  const audit = await gateway.listAudit({ message_id: "msg-request-1" });
  const accepted = audit.find((event) => event.type === "envelope.accepted");

  assert.equal(accepted.details.bridge_alignment.request_id, "msg-request-1");
  assert.equal(accepted.details.bridge_alignment.layer_role, "agent_orchestration_mesh");
  assert.equal(accepted.details.route_policy_concept.boundary, "package_local_stub");
  assert.equal(accepted.details.correlation_semantics.correlation_id, "corr-1");
});

function envelope(overrides = {}) {
  return {
    schema: "openclaw.agent.message.v1",
    message_id: "msg-request-1",
    created_at: "2026-05-09T11:59:00.000Z",
    workspace_id: "workspace.joseph",
    domain_id: "domain.nestdev",
    conversation_id: "conversation-1",
    from: "agent.chief_of_staff",
    to: "agent.software_engineer",
    intent: "request",
    ttl: 4,
    hop_count: 0,
    idempotency_key: "idem-request-1",
    content: { text: "Inspect the failing test." },
    correlation_id: "corr-1",
    ...overrides
  };
}

function contexts() {
  return [
    {
      id: "workspace.joseph",
      type: "workspace",
      name: "Joseph Workspace",
      parent_id: null,
      owner_human: "joseph",
      policy_profile: "workspace_standard",
      status: "active"
    },
    {
      id: "domain.nestdev",
      type: "company",
      name: "NestDev",
      parent_id: "workspace.joseph",
      policy_profile: "software_business_standard",
      status: "active"
    }
  ];
}

function agents() {
  return [
    {
      id: "agent.chief_of_staff",
      name: "Chief of Staff",
      role: "orchestration",
      status: "simulated",
      phase_1_active: true,
      capabilities: ["route_request"],
      enabled_contexts: ["workspace.joseph", "domain.nestdev"]
    },
    {
      id: "agent.software_engineer",
      name: "Software Engineer",
      role: "software_engineering",
      status: "simulated",
      phase_1_active: true,
      capabilities: ["propose_codex_execution_job_stub"],
      enabled_contexts: ["domain.nestdev"]
    }
  ];
}
