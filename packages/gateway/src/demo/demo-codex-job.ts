import { GatewayService } from "../core/gateway-service.js";
import { newEventId } from "../core/ndjson-store.js";

export function describeCodexJobDemo(): string {
  return "Submits one rerun-safe execution_job envelope; the Codex adapter persists an execution_job stub only.";
}

export async function runCodexJobDemo(): Promise<Record<string, unknown>> {
  const gateway = await GatewayService.create();
  const runId = newEventId("demo");
  const result = await gateway.submitEnvelope({
    schema: "openclaw.agent.message.v1",
    message_id: `demo-codex-job-${runId}`,
    created_at: new Date().toISOString(),
    workspace_id: "workspace.the operator",
    domain_id: "domain.nestdev",
    conversation_id: `demo-conversation-codex-job-${runId}`,
    from: "agent.software_engineer",
    to: "agent.software_engineer",
    intent: "execution_job",
    ttl: 4,
    hop_count: 0,
    idempotency_key: `demo-codex-job-${runId}`,
    correlation_id: `demo-correlation-codex-job-${runId}`,
    content: {
      summary: "Create a stub-only Codex execution job for Phase 1.",
      policy_profile: "software_business_standard",
      endpoint_id: "runner-stub-local",
      workspace_dir: "/path/to/runtime/workspace/openclaw-agent-mesh-gateway",
      repo_scope: "openclaw-agent-mesh-gateway",
      approval_profile: "phase-1-stub-only",
      approval_required: true,
      control_intent: "run",
      project_id: "project.agent_mesh",
      requested_capability: "codex.run.stub"
    },
    metadata: {
      demo: true,
      allow_self_message: true
    }
  });

  return {
    message_id: result.envelope.message_id,
    duplicate: result.duplicate,
    deliveries: result.deliveries.map((delivery) => ({
      adapter_id: delivery.adapter_id,
      status: delivery.status
    }))
  };
}
