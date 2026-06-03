import type { AgentMessageEnvelopeV1 } from "../schema/envelope.js";
import type { JsonObject, JsonValue } from "../schema/validation.js";

export const BRIDGE_ALIGNMENT_SCHEMA = "openclaw.agent_mesh.bridge_alignment.v1" as const;

export type BridgeAlignedRouteMode =
  | "request"
  | "reply"
  | "notification"
  | "approval_request"
  | "memory_proposal"
  | "execution_job"
  | "heartbeat";

export interface BridgeAlignedEnvelopeView extends JsonObject {
  schema: typeof BRIDGE_ALIGNMENT_SCHEMA;
  layer_role: "agent_orchestration_mesh";
  reused_bridge_patterns: string[];
  request_id: string;
  correlation_id: string;
  reply_to_request_id: string | null;
  mode: BridgeAlignedRouteMode;
  source: string;
  destination: string;
  operation: string;
  payload: JsonObject;
  metadata: JsonObject;
  idempotency_key: string;
  created_at: string;
}

export interface MeshRoutePolicyConcept extends JsonObject {
  schema: typeof BRIDGE_ALIGNMENT_SCHEMA;
  route_family: "agent_orchestration";
  boundary: "package_local_stub";
  source_agent_id: string;
  target_agent_id: string;
  context_id: string;
  opens_reply_window: boolean;
  requires_reply_parent: boolean;
  delivery_contract: "async_lifecycle";
  external_side_effects_allowed: false;
}

export interface CorrelationSemantics extends JsonObject {
  schema: typeof BRIDGE_ALIGNMENT_SCHEMA;
  trace_id: string;
  correlation_id: string;
  causation_id: string | null;
  reply_to_request_id: string | null;
  is_reply: boolean;
  issues: string[];
}

export function mapEnvelopeToBridgeAlignedView(
  envelope: AgentMessageEnvelopeV1
): BridgeAlignedEnvelopeView {
  return {
    schema: BRIDGE_ALIGNMENT_SCHEMA,
    layer_role: "agent_orchestration_mesh",
    reused_bridge_patterns: [
      "request_envelope",
      "correlation_id",
      "reply_parent_link",
      "idempotency_key",
      "append_only_audit",
      "adapter_delivery"
    ],
    request_id: envelope.message_id,
    correlation_id: effectiveCorrelationId(envelope),
    reply_to_request_id: replyToRequestId(envelope),
    mode: envelope.intent,
    source: envelope.from,
    destination: envelope.to,
    operation: `agent_mesh.${envelope.intent}`,
    payload: envelope.content,
    metadata: bridgeMetadata(envelope),
    idempotency_key: envelope.idempotency_key,
    created_at: envelope.created_at
  };
}

export function deriveMeshRoutePolicyConcept(
  envelope: AgentMessageEnvelopeV1
): MeshRoutePolicyConcept {
  return {
    schema: BRIDGE_ALIGNMENT_SCHEMA,
    route_family: "agent_orchestration",
    boundary: "package_local_stub",
    source_agent_id: envelope.from,
    target_agent_id: envelope.to,
    context_id: envelope.domain_id,
    opens_reply_window: opensReplyWindow(envelope),
    requires_reply_parent: envelope.intent === "reply",
    delivery_contract: "async_lifecycle",
    external_side_effects_allowed: false
  };
}

export function describeCorrelationSemantics(
  envelope: AgentMessageEnvelopeV1
): CorrelationSemantics {
  const isReply = envelope.intent === "reply";
  const causationId = envelope.causation_id ?? null;
  const replyTo = replyToRequestId(envelope);
  const issues: string[] = [];

  if (isReply && replyTo === null) {
    issues.push("reply_missing_parent_reference");
  }
  if (envelope.correlation_id === null) {
    issues.push("correlation_id_explicitly_null");
  }
  if (envelope.trace_id === null) {
    issues.push("trace_id_explicitly_null");
  }

  return {
    schema: BRIDGE_ALIGNMENT_SCHEMA,
    trace_id: envelope.trace_id ?? effectiveCorrelationId(envelope),
    correlation_id: effectiveCorrelationId(envelope),
    causation_id: causationId,
    reply_to_request_id: replyTo,
    is_reply: isReply,
    issues
  };
}

function effectiveCorrelationId(envelope: AgentMessageEnvelopeV1): string {
  return envelope.correlation_id ?? envelope.trace_id ?? envelope.message_id;
}

function replyToRequestId(envelope: AgentMessageEnvelopeV1): string | null {
  if (envelope.intent !== "reply") {
    return envelope.causation_id ?? null;
  }
  return envelope.causation_id ?? null;
}

function opensReplyWindow(envelope: AgentMessageEnvelopeV1): boolean {
  return envelope.intent === "request" || envelope.intent === "approval_request";
}

function bridgeMetadata(envelope: AgentMessageEnvelopeV1): JsonObject {
  return {
    workspace_id: envelope.workspace_id,
    domain_id: envelope.domain_id,
    conversation_id: envelope.conversation_id,
    project_id: envelope.project_id ?? null,
    task_id: envelope.task_id ?? null,
    sensitivity: envelope.sensitivity ?? null,
    redaction_state: envelope.redaction_state ?? null,
    mesh_metadata: (envelope.metadata ?? {}) as JsonValue
  };
}
