import {
  fail,
  isRecord,
  ok,
  optionalJsonObject,
  optionalIsoDateString,
  requireEnum,
  requireIsoDateString,
  requireString,
  type JsonObject,
  type ValidationIssue,
  type ValidationResult
} from "./validation.js";

export const HEARTBEAT_STATUSES = ["online", "offline", "simulated"] as const;
export type HeartbeatStatus = (typeof HEARTBEAT_STATUSES)[number];

export interface HeartbeatInput {
  agent_id: string;
  status: HeartbeatStatus;
  observed_at?: string;
  details?: JsonObject;
}

export interface HeartbeatRecord extends HeartbeatInput {
  id: string;
  observed_at: string;
}

export function validateHeartbeatInput(input: unknown): ValidationResult<HeartbeatInput> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const agentId = requireString(input, "agent_id", issues);
  const status = requireEnum(input, "status", HEARTBEAT_STATUSES, issues);
  const observedAt = optionalIsoDateString(input, "observed_at", issues);
  const details = optionalJsonObject(input, "details", issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({
    agent_id: agentId!,
    status: status!,
    ...(observedAt !== undefined ? { observed_at: observedAt } : {}),
    ...(details !== undefined ? { details } : {})
  });
}

export function validateHeartbeatRecord(input: unknown): ValidationResult<HeartbeatRecord> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const inputResult = validateHeartbeatInput(input);
  const issues: ValidationIssue[] = inputResult.ok ? [] : [...inputResult.issues];
  const id = requireString(input, "id", issues);
  const observedAt = requireIsoDateString(input, "observed_at", issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({
    ...inputResult.value!,
    id: id!,
    observed_at: observedAt!
  });
}
