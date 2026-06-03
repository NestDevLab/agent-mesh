import {
  type DiscordDeliveryContentPreview,
  type DiscordDeliveryMessageKind,
  type DiscordDeliveryPlan,
  type DiscordDeliveryTarget
} from "../schema/discord-delivery-plan.js";
import {
  type RedactionState,
  type SensitivityLevel
} from "../schema/envelope.js";
import type { JsonObject } from "../schema/validation.js";
import {
  canonicalInputHash,
  isoNow,
  newEventId,
  type StoreClock
} from "./ndjson-store.js";

export interface DiscordDeliveryPlanRequest {
  message_kind: DiscordDeliveryMessageKind;
  workspace_id: string;
  domain_id: string;
  conversation_id?: string | null;
  source_event_id?: string | null;
  source_message_id?: string | null;
  target: DiscordDeliveryTarget;
  content: DiscordDeliveryContentPreview;
  sensitivity: SensitivityLevel;
  redaction_state: RedactionState;
  idempotency_key?: string;
  dry_run: boolean;
  no_external_send: boolean;
  metadata?: JsonObject;
}

export function planDiscordDelivery(
  request: DiscordDeliveryPlanRequest,
  options: { clock?: StoreClock } = {}
): DiscordDeliveryPlan {
  const createdAt = isoNow(options.clock);
  const riskFlags = riskFlagsFor(request);
  const policy = decisionFor(request, riskFlags);

  return {
    id: newEventId("discord_delivery_plan"),
    message_kind: request.message_kind,
    workspace_id: request.workspace_id,
    domain_id: request.domain_id,
    ...(request.conversation_id !== undefined ? { conversation_id: request.conversation_id } : {}),
    ...(request.source_event_id !== undefined ? { source_event_id: request.source_event_id } : {}),
    ...(request.source_message_id !== undefined
      ? { source_message_id: request.source_message_id }
      : {}),
    target: request.target,
    content: request.content,
    sensitivity: request.sensitivity,
    redaction_state: request.redaction_state,
    visibility: request.sensitivity,
    idempotency_key: request.idempotency_key ?? derivedIdempotencyKey(request),
    decision: policy.decision,
    status: policy.status,
    reason: policy.reason,
    risk_flags: riskFlags,
    dry_run: true,
    no_external_send: true,
    adapter_flags: {
      discord_adapter_called: false,
      openclaw_message_tool_called: false,
      discord_objects_mutated: false
    },
    created_at: createdAt,
    ...(request.metadata !== undefined ? { metadata: request.metadata } : {})
  };
}

function decisionFor(
  request: DiscordDeliveryPlanRequest,
  riskFlags: string[]
): Pick<DiscordDeliveryPlan, "decision" | "status" | "reason"> {
  if (!request.dry_run || !request.no_external_send) {
    return {
      decision: "deny",
      status: "denied_stubbed",
      reason: "Discord delivery planner requires dry_run and no_external_send."
    };
  }

  if (request.sensitivity === "secret" && request.redaction_state !== "redacted") {
    return {
      decision: "deny",
      status: "denied_stubbed",
      reason: "Secret Discord payloads are denied unless fully redacted."
    };
  }

  if (request.sensitivity === "private" || request.sensitivity === "confidential") {
    return {
      decision: "ask-human",
      status: "requires_human_stubbed",
      reason: "Private or confidential Discord delivery requires human approval."
    };
  }

  if (riskFlags.includes("route-missing-thread")) {
    return {
      decision: "ask-human",
      status: "requires_human_stubbed",
      reason: "Discord delivery target lacks a thread id and requires route review."
    };
  }

  return {
    decision: "allow-dry-run",
    status: "planned_stubbed",
    reason: "Dry-run Discord delivery plan recorded without external send."
  };
}

function riskFlagsFor(request: DiscordDeliveryPlanRequest): string[] {
  const flags = ["stub-only", "no-external-send"];

  if (!request.dry_run) {
    flags.push("dry-run-required");
  }
  if (!request.no_external_send) {
    flags.push("no-external-send-required");
  }
  if (request.sensitivity === "secret" && request.redaction_state !== "redacted") {
    flags.push("secret-unredacted");
  }
  if (request.sensitivity === "private" || request.sensitivity === "confidential") {
    flags.push(`${request.sensitivity}-requires-human`);
  }
  if (!request.target.thread_id) {
    flags.push("route-missing-thread");
  }

  return flags;
}

function derivedIdempotencyKey(request: DiscordDeliveryPlanRequest): string {
  return `discord_delivery_plan:${canonicalInputHash({
    message_kind: request.message_kind,
    workspace_id: request.workspace_id,
    domain_id: request.domain_id,
    conversation_id: request.conversation_id ?? null,
    source_event_id: request.source_event_id ?? null,
    source_message_id: request.source_message_id ?? null,
    target: request.target,
    sensitivity: request.sensitivity,
    redaction_state: request.redaction_state,
    content: request.content
  })}`;
}
