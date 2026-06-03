import {
  fail,
  isJsonObject,
  isRecord,
  ok,
  optionalEnum,
  optionalIsoDateString,
  optionalJsonObject,
  optionalStringArray,
  optionalStringOrNull,
  requireEnum,
  requireInteger,
  requireIsoDateString,
  requireString,
  type JsonObject,
  type ValidationIssue,
  type ValidationResult
} from "./validation.js";

export const AGENT_MESSAGE_SCHEMA = "openclaw.agent.message.v1" as const;
export const AGENT_MESSAGE_ENVELOPE_VERSION = AGENT_MESSAGE_SCHEMA;

export const AGENT_MESSAGE_INTENTS = [
  "request",
  "reply",
  "notification",
  "approval_request",
  "memory_proposal",
  "execution_job",
  "heartbeat"
] as const;

export type AgentMessageIntent = (typeof AGENT_MESSAGE_INTENTS)[number];

export const SENSITIVITY_LEVELS = [
  "public",
  "internal",
  "private",
  "confidential",
  "secret"
] as const;

export type SensitivityLevel = (typeof SENSITIVITY_LEVELS)[number];

export const REDACTION_STATES = [
  "none",
  "redacted",
  "partial",
  "required"
] as const;

export type RedactionState = (typeof REDACTION_STATES)[number];

export interface AgentMessageEnvelopeV1 {
  schema: typeof AGENT_MESSAGE_SCHEMA;
  message_id: string;
  created_at: string;
  workspace_id: string;
  domain_id: string;
  conversation_id: string;
  from: string;
  to: string;
  intent: AgentMessageIntent;
  ttl: number;
  hop_count: number;
  idempotency_key: string;
  content: JsonObject;
  schema_version?: string | null;
  trace_id?: string | null;
  correlation_id?: string | null;
  causation_id?: string | null;
  content_hash?: string | null;
  payload_size_bytes?: number;
  sensitivity?: SensitivityLevel;
  redaction_state?: RedactionState;
  expires_at?: string;
  labels?: string[];
  metadata?: JsonObject;
  project_id?: string | null;
  task_id?: string | null;
}

export type SubmitEnvelopeInput = unknown;

export function validateAgentMessageEnvelopeV1(
  input: unknown
): ValidationResult<AgentMessageEnvelopeV1> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const schema = requireString(input, "schema", issues);
  if (schema !== undefined && schema !== AGENT_MESSAGE_SCHEMA) {
    issues.push({ path: "schema", message: `must be ${AGENT_MESSAGE_SCHEMA}` });
  }

  const messageId = requireString(input, "message_id", issues);
  const workspaceId = requireString(input, "workspace_id", issues);
  const domainId = requireString(input, "domain_id", issues);
  const conversationId = requireString(input, "conversation_id", issues);
  const from = requireString(input, "from", issues);
  const to = requireString(input, "to", issues);
  const intent = requireEnum(input, "intent", AGENT_MESSAGE_INTENTS, issues);
  const ttl = requireInteger(input, "ttl", issues);
  if (ttl !== undefined && ttl <= 0) {
    issues.push({ path: "ttl", message: "must be greater than 0" });
  }
  const hopCount = requireInteger(input, "hop_count", issues);
  if (hopCount !== undefined && hopCount < 0) {
    issues.push({ path: "hop_count", message: "must be greater than or equal to 0" });
  }
  const idempotencyKey = requireString(input, "idempotency_key", issues);
  const createdAt = requireIsoDateString(input, "created_at", issues);

  const content = input.content;
  if (!isJsonObject(content)) {
    issues.push({ path: "content", message: "must be a JSON object" });
  }

  const schemaVersion = optionalStringOrNull(input, "schema_version", issues);
  const traceId = optionalStringOrNull(input, "trace_id", issues);
  const correlationId = optionalStringOrNull(input, "correlation_id", issues);
  const causationId = optionalStringOrNull(input, "causation_id", issues);
  const contentHash = optionalStringOrNull(input, "content_hash", issues);
  const payloadSizeBytes = input.payload_size_bytes;
  if (
    payloadSizeBytes !== undefined &&
    (typeof payloadSizeBytes !== "number" ||
      !Number.isInteger(payloadSizeBytes) ||
      payloadSizeBytes < 0)
  ) {
    issues.push({
      path: "payload_size_bytes",
      message: "must be a non-negative integer"
    });
  }
  const sensitivity = optionalEnum(input, "sensitivity", SENSITIVITY_LEVELS, issues);
  const redactionState = optionalEnum(input, "redaction_state", REDACTION_STATES, issues);
  const expiresAt = optionalIsoDateString(input, "expires_at", issues);
  const labels = optionalStringArray(input, "labels", issues);
  const metadata = optionalJsonObject(input, "metadata", issues);
  const projectId = optionalStringOrNull(input, "project_id", issues);
  const taskId = optionalStringOrNull(input, "task_id", issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({
    schema: AGENT_MESSAGE_SCHEMA,
    message_id: messageId!,
    workspace_id: workspaceId!,
    domain_id: domainId!,
    conversation_id: conversationId!,
    from: from!,
    to: to!,
    intent: intent!,
    ttl: ttl!,
    hop_count: hopCount!,
    idempotency_key: idempotencyKey!,
    content: content as JsonObject,
    created_at: createdAt!,
    ...(schemaVersion !== undefined ? { schema_version: schemaVersion } : {}),
    ...(traceId !== undefined ? { trace_id: traceId } : {}),
    ...(correlationId !== undefined ? { correlation_id: correlationId } : {}),
    ...(causationId !== undefined ? { causation_id: causationId } : {}),
    ...(contentHash !== undefined ? { content_hash: contentHash } : {}),
    ...(payloadSizeBytes !== undefined ? { payload_size_bytes: payloadSizeBytes as number } : {}),
    ...(sensitivity !== undefined ? { sensitivity } : {}),
    ...(redactionState !== undefined ? { redaction_state: redactionState } : {}),
    ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
    ...(labels !== undefined ? { labels } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(projectId !== undefined ? { project_id: projectId } : {}),
    ...(taskId !== undefined ? { task_id: taskId } : {})
  });
}

export function assertAgentMessageEnvelopeV1(input: unknown): AgentMessageEnvelopeV1 {
  const result = validateAgentMessageEnvelopeV1(input);
  if (!result.ok) {
    throw new Error(
      `Invalid agent message envelope: ${result.issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join("; ")}`
    );
  }
  return result.value!;
}
