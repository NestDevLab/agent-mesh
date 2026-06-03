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

export const CONVERSATION_ACT_SCHEMA = "openclaw.agent_os.conversation_act.v1" as const;

export const CONVERSATION_ACT_TYPES = [
  "contribution",
  "progress_update",
  "waiting",
  "blocked",
  "question",
  "handoff",
  "review",
  "complete",
  "correction",
  "pause_ack",
  "commitment",
  "noise"
] as const;
export type ConversationActType = (typeof CONVERSATION_ACT_TYPES)[number];

export interface ConversationActRecord {
  schema: typeof CONVERSATION_ACT_SCHEMA;
  task_id: string;
  message_id: string;
  actor_id: string;
  observed_at: string;
  act: ConversationActType;
  summary: string;
  confidence: number;
  target_agent_id?: string | null;
  evidence_ref?: string | null;
  metadata?: JsonObject;
}

export function validateConversationActRecord(
  input: unknown
): ValidationResult<ConversationActRecord> {
  if (!isRecord(input)) return fail([{ path: "$", message: "must be a JSON object" }]);
  const issues: ValidationIssue[] = [];
  const schema = requireLiteral(input, "schema", CONVERSATION_ACT_SCHEMA, issues);
  const taskId = requireString(input, "task_id", issues);
  const messageId = requireString(input, "message_id", issues);
  const actorId = requireString(input, "actor_id", issues);
  const observedAt = requireIsoDateString(input, "observed_at", issues);
  const act = requireEnum(input, "act", CONVERSATION_ACT_TYPES, issues);
  const summary = requireString(input, "summary", issues);
  const confidence = requireConfidence(input, "confidence", issues);
  const targetAgentId = optionalStringOrNull(input, "target_agent_id", issues);
  const evidenceRef = optionalStringOrNull(input, "evidence_ref", issues);
  const metadata = optionalJsonObject(input, "metadata", issues);
  if (issues.length > 0) return fail(issues);
  return ok({
    schema: schema!,
    task_id: taskId!,
    message_id: messageId!,
    actor_id: actorId!,
    observed_at: observedAt!,
    act: act!,
    summary: summary!,
    confidence: confidence!,
    ...(targetAgentId !== undefined ? { target_agent_id: targetAgentId } : {}),
    ...(evidenceRef !== undefined ? { evidence_ref: evidenceRef } : {}),
    ...(metadata !== undefined ? { metadata } : {})
  });
}

function requireLiteral<T extends string>(
  input: Record<string, unknown>,
  key: string,
  value: T,
  issues: ValidationIssue[]
): T | undefined {
  if (input[key] === value) return value;
  issues.push({ path: key, message: `must equal ${value}` });
  return undefined;
}

function requireConfidence(
  input: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): number | undefined {
  const value = input[key];
  if (typeof value === "number" && value >= 0 && value <= 1) return value;
  issues.push({ path: key, message: "must be a number between 0 and 1" });
  return undefined;
}
