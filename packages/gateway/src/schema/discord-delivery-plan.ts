import {
  fail,
  isRecord,
  ok,
  optionalJsonObject,
  optionalStringOrNull,
  requireEnum,
  requireIsoDateString,
  requireString,
  type JsonObject,
  type ValidationIssue,
  type ValidationResult
} from "./validation.js";
import { REDACTION_STATES, SENSITIVITY_LEVELS, type RedactionState, type SensitivityLevel } from "./envelope.js";

export const DISCORD_DELIVERY_MESSAGE_KINDS = [
  "safe_status_summary",
  "approval_request",
  "task_thread_summary",
  "incident_or_blocker",
  "audit_digest"
] as const;
export type DiscordDeliveryMessageKind = (typeof DISCORD_DELIVERY_MESSAGE_KINDS)[number];

export const DISCORD_DELIVERY_DECISIONS = [
  "allow-dry-run",
  "ask-human",
  "deny"
] as const;
export type DiscordDeliveryDecision = (typeof DISCORD_DELIVERY_DECISIONS)[number];

export const DISCORD_DELIVERY_PLAN_STATUSES = [
  "planned_stubbed",
  "requires_human_stubbed",
  "denied_stubbed"
] as const;
export type DiscordDeliveryPlanStatus = (typeof DISCORD_DELIVERY_PLAN_STATUSES)[number];

export interface DiscordDeliveryTarget {
  surface: "discord";
  guild_id?: string | null;
  channel_id: string;
  thread_id?: string | null;
  route_policy_id?: string | null;
  metadata?: JsonObject;
}

export interface DiscordDeliveryContentPreview {
  title: string;
  body: string;
}

export interface DiscordDeliveryAdapterFlags {
  discord_adapter_called: false;
  openclaw_message_tool_called: false;
  discord_objects_mutated: false;
}

export interface DiscordDeliveryPlan {
  id: string;
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
  visibility: SensitivityLevel;
  idempotency_key: string;
  decision: DiscordDeliveryDecision;
  status: DiscordDeliveryPlanStatus;
  reason: string;
  risk_flags: string[];
  dry_run: true;
  no_external_send: true;
  adapter_flags: DiscordDeliveryAdapterFlags;
  created_at: string;
  metadata?: JsonObject;
}

export function validateDiscordDeliveryPlan(
  input: unknown
): ValidationResult<DiscordDeliveryPlan> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const id = requireString(input, "id", issues);
  const messageKind = requireEnum(input, "message_kind", DISCORD_DELIVERY_MESSAGE_KINDS, issues);
  const workspaceId = requireString(input, "workspace_id", issues);
  const domainId = requireString(input, "domain_id", issues);
  const conversationId = optionalStringOrNull(input, "conversation_id", issues);
  const sourceEventId = optionalStringOrNull(input, "source_event_id", issues);
  const sourceMessageId = optionalStringOrNull(input, "source_message_id", issues);
  const target = validateDiscordDeliveryTarget(input.target);
  if (!target.ok) {
    for (const issue of target.issues) {
      issues.push({ path: `target.${issue.path}`, message: issue.message });
    }
  }
  const content = validateDiscordDeliveryContentPreview(input.content);
  if (!content.ok) {
    for (const issue of content.issues) {
      issues.push({ path: `content.${issue.path}`, message: issue.message });
    }
  }
  const sensitivity = requireEnum(input, "sensitivity", SENSITIVITY_LEVELS, issues);
  const redactionState = requireEnum(input, "redaction_state", REDACTION_STATES, issues);
  const visibility = requireEnum(input, "visibility", SENSITIVITY_LEVELS, issues);
  const idempotencyKey = requireString(input, "idempotency_key", issues);
  const decision = requireEnum(input, "decision", DISCORD_DELIVERY_DECISIONS, issues);
  const status = requireEnum(input, "status", DISCORD_DELIVERY_PLAN_STATUSES, issues);
  const reason = requireString(input, "reason", issues);
  const riskFlags = requireStringArray(input, "risk_flags", issues);
  const dryRun = requireTrue(input, "dry_run", issues);
  const noExternalSend = requireTrue(input, "no_external_send", issues);
  const adapterFlags = validateDiscordDeliveryAdapterFlags(input.adapter_flags);
  if (!adapterFlags.ok) {
    for (const issue of adapterFlags.issues) {
      issues.push({ path: `adapter_flags.${issue.path}`, message: issue.message });
    }
  }
  const createdAt = requireIsoDateString(input, "created_at", issues);
  const metadata = optionalJsonObject(input, "metadata", issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({
    id: id!,
    message_kind: messageKind!,
    workspace_id: workspaceId!,
    domain_id: domainId!,
    ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
    ...(sourceEventId !== undefined ? { source_event_id: sourceEventId } : {}),
    ...(sourceMessageId !== undefined ? { source_message_id: sourceMessageId } : {}),
    target: target.value!,
    content: content.value!,
    sensitivity: sensitivity!,
    redaction_state: redactionState!,
    visibility: visibility!,
    idempotency_key: idempotencyKey!,
    decision: decision!,
    status: status!,
    reason: reason!,
    risk_flags: riskFlags!,
    dry_run: dryRun!,
    no_external_send: noExternalSend!,
    adapter_flags: adapterFlags.value!,
    created_at: createdAt!,
    ...(metadata !== undefined ? { metadata } : {})
  });
}

function validateDiscordDeliveryTarget(
  input: unknown
): ValidationResult<DiscordDeliveryTarget> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const surface = requireEnum(input, "surface", ["discord"] as const, issues);
  const guildId = optionalStringOrNull(input, "guild_id", issues);
  const channelId = requireString(input, "channel_id", issues);
  const threadId = optionalStringOrNull(input, "thread_id", issues);
  const routePolicyId = optionalStringOrNull(input, "route_policy_id", issues);
  const metadata = optionalJsonObject(input, "metadata", issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({
    surface: surface!,
    ...(guildId !== undefined ? { guild_id: guildId } : {}),
    channel_id: channelId!,
    ...(threadId !== undefined ? { thread_id: threadId } : {}),
    ...(routePolicyId !== undefined ? { route_policy_id: routePolicyId } : {}),
    ...(metadata !== undefined ? { metadata } : {})
  });
}

function validateDiscordDeliveryContentPreview(
  input: unknown
): ValidationResult<DiscordDeliveryContentPreview> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const title = requireString(input, "title", issues);
  const body = requireString(input, "body", issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({ title: title!, body: body! });
}

function validateDiscordDeliveryAdapterFlags(
  input: unknown
): ValidationResult<DiscordDeliveryAdapterFlags> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const discordAdapterCalled = requireFalse(input, "discord_adapter_called", issues);
  const openclawMessageToolCalled = requireFalse(input, "openclaw_message_tool_called", issues);
  const discordObjectsMutated = requireFalse(input, "discord_objects_mutated", issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({
    discord_adapter_called: discordAdapterCalled!,
    openclaw_message_tool_called: openclawMessageToolCalled!,
    discord_objects_mutated: discordObjectsMutated!
  });
}

function requireTrue(
  input: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): true | undefined {
  if (input[key] === true) {
    return true;
  }
  issues.push({ path: key, message: "must be true" });
  return undefined;
}

function requireFalse(
  input: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): false | undefined {
  if (input[key] === false) {
    return false;
  }
  issues.push({ path: key, message: "must be false" });
  return undefined;
}

function requireStringArray(
  input: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): string[] | undefined {
  const value = input[key];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  issues.push({ path: key, message: "must be an array of strings" });
  return undefined;
}
