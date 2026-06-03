import {
  fail,
  isRecord,
  ok,
  optionalJsonObject,
  requireEnum,
  requireIsoDateString,
  requireString,
  type JsonObject,
  type ValidationIssue,
  type ValidationResult
} from "./validation.js";

export const AUDIT_EVENT_TYPES = [
  "envelope.accepted",
  "envelope.rejected",
  "delivery.queued",
  "delivery.updated",
  "delivery.invalid_transition",
  "delivery.dead_lettered",
  "gateway.recovered",
  "heartbeat.recorded",
  "approval.requested",
  "approval.decided",
  "execution_job.stubbed"
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export interface AuditEvent {
  id: string;
  type: AuditEventType;
  created_at: string;
  message_id?: string;
  correlation_id?: string;
  actor_id?: string;
  details: JsonObject;
}

export interface AuditFilter {
  type?: AuditEventType;
  message_id?: string;
  correlation_id?: string;
}

export function validateAuditEvent(input: unknown): ValidationResult<AuditEvent> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const id = requireString(input, "id", issues);
  const type = requireEnum(input, "type", AUDIT_EVENT_TYPES, issues);
  const createdAt = requireIsoDateString(input, "created_at", issues);
  const messageId =
    input.message_id === undefined ? undefined : requireString(input, "message_id", issues);
  const correlationId =
    input.correlation_id === undefined
      ? undefined
      : requireString(input, "correlation_id", issues);
  const actorId =
    input.actor_id === undefined ? undefined : requireString(input, "actor_id", issues);
  const details = optionalJsonObject(input, "details", issues);
  if (!Object.hasOwn(input, "details")) {
    issues.push({ path: "details", message: "is required" });
  }

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({
    id: id!,
    type: type!,
    created_at: createdAt!,
    ...(messageId !== undefined ? { message_id: messageId } : {}),
    ...(correlationId !== undefined ? { correlation_id: correlationId } : {}),
    ...(actorId !== undefined ? { actor_id: actorId } : {}),
    details: details!
  });
}
