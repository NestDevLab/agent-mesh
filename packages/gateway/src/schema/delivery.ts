import {
  fail,
  isRecord,
  ok,
  requireEnum,
  requireInteger,
  requireIsoDateString,
  requireString,
  type ValidationIssue,
  type ValidationResult
} from "./validation.js";

export const DELIVERY_STATUSES = [
  "queued",
  "dispatching",
  "delivered",
  "failed",
  "expired",
  "stubbed",
  "waiting_capacity"
] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export interface DeliveryRecord {
  id: string;
  message_id: string;
  adapter_id: string;
  target_agent_id: string;
  status: DeliveryStatus;
  attempts: number;
  max_attempts: number;
  created_at: string;
  updated_at: string;
  last_error?: string;
}

export function validateDeliveryRecord(input: unknown): ValidationResult<DeliveryRecord> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const id = requireString(input, "id", issues);
  const messageId = requireString(input, "message_id", issues);
  const adapterId = requireString(input, "adapter_id", issues);
  const targetAgentId = requireString(input, "target_agent_id", issues);
  const status = requireEnum(input, "status", DELIVERY_STATUSES, issues);
  const attempts = requireInteger(input, "attempts", issues);
  if (attempts !== undefined && attempts < 0) {
    issues.push({ path: "attempts", message: "must be greater than or equal to 0" });
  }
  const maxAttempts = requireInteger(input, "max_attempts", issues);
  if (maxAttempts !== undefined && maxAttempts < 1) {
    issues.push({ path: "max_attempts", message: "must be greater than or equal to 1" });
  }
  const createdAt = requireIsoDateString(input, "created_at", issues);
  const updatedAt = requireIsoDateString(input, "updated_at", issues);
  const lastError =
    input.last_error === undefined ? undefined : requireString(input, "last_error", issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({
    id: id!,
    message_id: messageId!,
    adapter_id: adapterId!,
    target_agent_id: targetAgentId!,
    status: status!,
    attempts: attempts!,
    max_attempts: maxAttempts!,
    created_at: createdAt!,
    updated_at: updatedAt!,
    ...(lastError !== undefined ? { last_error: lastError } : {})
  });
}
