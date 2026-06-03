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

export const DISCORD_SEND_ATTEMPT_SCHEMA = "openclaw.agent.discord_send_attempt.v1" as const;

export const DISCORD_SEND_STATUSES = ["sent", "denied", "failed"] as const;
export type DiscordSendStatus = (typeof DISCORD_SEND_STATUSES)[number];

export interface DiscordSendAttemptRecord {
  schema: typeof DISCORD_SEND_ATTEMPT_SCHEMA;
  attempt_id: string;
  delivery_plan_id: string;
  policy_decision_id: string;
  idempotency_key: string;
  status: DiscordSendStatus;
  reason: string;
  sender_called: boolean;
  sender_call_count: number;
  openclaw_message_tool_called: false;
  discord_message_id?: string | null;
  target: {
    surface: "discord";
    guild_id?: string | null;
    channel_id: string;
    thread_id?: string | null;
  };
  attempted_at: string;
  metadata?: JsonObject;
}

export function validateDiscordSendAttemptRecord(
  input: unknown
): ValidationResult<DiscordSendAttemptRecord> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const schema = requireEnum(input, "schema", [DISCORD_SEND_ATTEMPT_SCHEMA], issues);
  const attemptId = requireString(input, "attempt_id", issues);
  const deliveryPlanId = requireString(input, "delivery_plan_id", issues);
  const policyDecisionId = requireString(input, "policy_decision_id", issues);
  const idempotencyKey = requireString(input, "idempotency_key", issues);
  const status = requireEnum(input, "status", DISCORD_SEND_STATUSES, issues);
  const reason = requireString(input, "reason", issues);
  const senderCalled = requireBoolean(input, "sender_called", issues);
  const senderCallCount = requireNonNegativeInteger(input, "sender_call_count", issues);
  const openclawMessageToolCalled = requireFalse(input, "openclaw_message_tool_called", issues);
  const discordMessageId = optionalStringOrNull(input, "discord_message_id", issues);
  const target = validateAttemptTarget(input.target);
  if (!target.ok) {
    for (const issue of target.issues) {
      issues.push({ path: `target.${issue.path}`, message: issue.message });
    }
  }
  const attemptedAt = requireIsoDateString(input, "attempted_at", issues);
  const metadata = optionalJsonObject(input, "metadata", issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({
    schema: schema!,
    attempt_id: attemptId!,
    delivery_plan_id: deliveryPlanId!,
    policy_decision_id: policyDecisionId!,
    idempotency_key: idempotencyKey!,
    status: status!,
    reason: reason!,
    sender_called: senderCalled!,
    sender_call_count: senderCallCount!,
    openclaw_message_tool_called: openclawMessageToolCalled!,
    ...(discordMessageId !== undefined ? { discord_message_id: discordMessageId } : {}),
    target: target.value!,
    attempted_at: attemptedAt!,
    ...(metadata !== undefined ? { metadata } : {})
  });
}

function validateAttemptTarget(
  input: unknown
): ValidationResult<DiscordSendAttemptRecord["target"]> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const surface = requireEnum(input, "surface", ["discord"] as const, issues);
  const guildId = optionalStringOrNull(input, "guild_id", issues);
  const channelId = requireString(input, "channel_id", issues);
  const threadId = optionalStringOrNull(input, "thread_id", issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({
    surface: surface!,
    ...(guildId !== undefined ? { guild_id: guildId } : {}),
    channel_id: channelId!,
    ...(threadId !== undefined ? { thread_id: threadId } : {})
  });
}

function requireBoolean(
  input: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): boolean | undefined {
  if (typeof input[key] === "boolean") {
    return input[key];
  }
  issues.push({ path: key, message: "must be a boolean" });
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

function requireNonNegativeInteger(
  input: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): number | undefined {
  const value = input[key];
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  issues.push({ path: key, message: "must be a non-negative integer" });
  return undefined;
}
