import {
  fail,
  isRecord,
  ok,
  optionalIsoDateString,
  optionalJsonObject,
  optionalStringArray,
  optionalStringOrNull,
  requireEnum,
  requireIsoDateString,
  requireString,
  type JsonObject,
  type ValidationIssue,
  type ValidationResult
} from "./validation.js";

export const HUMAN_REQUEST_SCHEMA = "openclaw.agent_os.human_request.v1" as const;
export const HUMAN_DECISION_SCHEMA = "openclaw.agent_os.human_decision.v1" as const;

export const HUMAN_REQUEST_TYPES = [
  "approval",
  "decision",
  "missing_input",
  "preference",
  "exception"
] as const;
export type HumanRequestType = (typeof HUMAN_REQUEST_TYPES)[number];

export const HUMAN_REQUEST_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type HumanRequestPriority = (typeof HUMAN_REQUEST_PRIORITIES)[number];

export const HUMAN_REQUEST_STATUSES = [
  "drafted",
  "posted",
  "awaiting_human",
  "approved",
  "denied",
  "later",
  "ask_more",
  "expired",
  "resolved"
] as const;
export type HumanRequestStatus = (typeof HUMAN_REQUEST_STATUSES)[number];

export const HUMAN_RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type HumanRiskLevel = (typeof HUMAN_RISK_LEVELS)[number];

export const HUMAN_DECISIONS = ["approve", "deny", "later", "ask_more"] as const;
export type HumanDecision = (typeof HUMAN_DECISIONS)[number];

export interface HumanRequestRisk {
  risk_level: HumanRiskLevel;
  approval_triggers: string[];
  side_effects: string[];
}

export interface HumanRequestRecommendation {
  option: HumanDecision;
  rationale: string;
}

export interface HumanRequestDiscordRef {
  channel_id?: string | null;
  thread_id?: string | null;
  message_id?: string | null;
  url?: string | null;
}

export interface HumanRequestRecord {
  schema: typeof HUMAN_REQUEST_SCHEMA;
  request_id: string;
  task_id: string;
  task_title: string;
  request_type: HumanRequestType;
  priority: HumanRequestPriority;
  status: HumanRequestStatus;
  owner_agent_id: string;
  created_at: string;
  updated_at: string;
  canonical_state_ref: string;
  question: string;
  recommendation: HumanRequestRecommendation;
  risk: HumanRequestRisk;
  impact_if_unanswered: string;
  allowed_replies: HumanDecision[];
  idempotency_key: string;
  discord?: HumanRequestDiscordRef;
  metadata?: JsonObject;
}

export interface HumanDecisionApprovalScope {
  action: string;
  target?: string | null;
  single_use: boolean;
  expires_at?: string | null;
  constraints?: string[];
}

export interface HumanDecisionRecord {
  schema: typeof HUMAN_DECISION_SCHEMA;
  decision_id: string;
  request_id: string;
  task_id: string;
  decision: HumanDecision;
  decided_by: string;
  decided_at: string;
  decision_text_summary: string;
  approval_scope: HumanDecisionApprovalScope;
  next_task_state: string;
  state_update_refs: string[];
  metadata?: JsonObject;
}

export function validateHumanRequestRecord(
  input: unknown
): ValidationResult<HumanRequestRecord> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const schema = requireLiteral(input, "schema", HUMAN_REQUEST_SCHEMA, issues);
  const requestId = requireString(input, "request_id", issues);
  const taskId = requireString(input, "task_id", issues);
  const taskTitle = requireString(input, "task_title", issues);
  const requestType = requireEnum(input, "request_type", HUMAN_REQUEST_TYPES, issues);
  const priority = requireEnum(input, "priority", HUMAN_REQUEST_PRIORITIES, issues);
  const status = requireEnum(input, "status", HUMAN_REQUEST_STATUSES, issues);
  const ownerAgentId = requireString(input, "owner_agent_id", issues);
  const createdAt = requireIsoDateString(input, "created_at", issues);
  const updatedAt = requireIsoDateString(input, "updated_at", issues);
  const canonicalStateRef = requireString(input, "canonical_state_ref", issues);
  const question = requireString(input, "question", issues);
  const recommendation = requireRecommendation(input.recommendation, "recommendation", issues);
  const risk = requireRisk(input.risk, "risk", issues);
  const impactIfUnanswered = requireString(input, "impact_if_unanswered", issues);
  const allowedReplies = requireDecisionArray(input, "allowed_replies", issues);
  const idempotencyKey = requireString(input, "idempotency_key", issues);
  const discord = optionalDiscordRef(input.discord, "discord", issues);
  const metadata = optionalJsonObject(input, "metadata", issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({
    schema: schema!,
    request_id: requestId!,
    task_id: taskId!,
    task_title: taskTitle!,
    request_type: requestType!,
    priority: priority!,
    status: status!,
    owner_agent_id: ownerAgentId!,
    created_at: createdAt!,
    updated_at: updatedAt!,
    canonical_state_ref: canonicalStateRef!,
    question: question!,
    recommendation: recommendation!,
    risk: risk!,
    impact_if_unanswered: impactIfUnanswered!,
    allowed_replies: allowedReplies!,
    idempotency_key: idempotencyKey!,
    ...(discord !== undefined ? { discord } : {}),
    ...(metadata !== undefined ? { metadata } : {})
  });
}

export function validateHumanDecisionRecord(
  input: unknown
): ValidationResult<HumanDecisionRecord> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const schema = requireLiteral(input, "schema", HUMAN_DECISION_SCHEMA, issues);
  const decisionId = requireString(input, "decision_id", issues);
  const requestId = requireString(input, "request_id", issues);
  const taskId = requireString(input, "task_id", issues);
  const decision = requireEnum(input, "decision", HUMAN_DECISIONS, issues);
  const decidedBy = requireString(input, "decided_by", issues);
  const decidedAt = requireIsoDateString(input, "decided_at", issues);
  const decisionTextSummary = requireString(input, "decision_text_summary", issues);
  const approvalScope = requireApprovalScope(input.approval_scope, "approval_scope", issues);
  const nextTaskState = requireString(input, "next_task_state", issues);
  const stateUpdateRefs = optionalStringArray(input, "state_update_refs", issues);
  if (!Object.hasOwn(input, "state_update_refs")) {
    issues.push({ path: "state_update_refs", message: "is required" });
  }
  const metadata = optionalJsonObject(input, "metadata", issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({
    schema: schema!,
    decision_id: decisionId!,
    request_id: requestId!,
    task_id: taskId!,
    decision: decision!,
    decided_by: decidedBy!,
    decided_at: decidedAt!,
    decision_text_summary: decisionTextSummary!,
    approval_scope: approvalScope!,
    next_task_state: nextTaskState!,
    state_update_refs: stateUpdateRefs!,
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

function requireRecommendation(
  value: unknown,
  path: string,
  issues: ValidationIssue[]
): HumanRequestRecommendation | undefined {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be a JSON object" });
    return undefined;
  }
  const option = requireEnum(value, "option", HUMAN_DECISIONS, issuesFor(path, issues));
  const rationale = requireString(value, "rationale", issuesFor(path, issues));
  if (!option || !rationale) return undefined;
  return { option, rationale };
}

function requireRisk(
  value: unknown,
  path: string,
  issues: ValidationIssue[]
): HumanRequestRisk | undefined {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be a JSON object" });
    return undefined;
  }
  const riskLevel = requireEnum(value, "risk_level", HUMAN_RISK_LEVELS, issuesFor(path, issues));
  const approvalTriggers = optionalStringArray(value, "approval_triggers", issuesFor(path, issues));
  const sideEffects = optionalStringArray(value, "side_effects", issuesFor(path, issues));
  if (!Object.hasOwn(value, "approval_triggers")) {
    issues.push({ path: `${path}.approval_triggers`, message: "is required" });
  }
  if (!Object.hasOwn(value, "side_effects")) {
    issues.push({ path: `${path}.side_effects`, message: "is required" });
  }
  if (!riskLevel || !approvalTriggers || !sideEffects) return undefined;
  return { risk_level: riskLevel, approval_triggers: approvalTriggers, side_effects: sideEffects };
}

function requireDecisionArray(
  input: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): HumanDecision[] | undefined {
  const value = input[key];
  if (!Array.isArray(value)) {
    issues.push({ path: key, message: "must be an array" });
    return undefined;
  }
  const out: HumanDecision[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (typeof item !== "string" || !HUMAN_DECISIONS.includes(item as HumanDecision)) {
      issues.push({ path: `${key}[${i}]`, message: `must be one of: ${HUMAN_DECISIONS.join(", ")}` });
      continue;
    }
    out.push(item as HumanDecision);
  }
  return issues.some((issue) => issue.path.startsWith(`${key}[`)) ? undefined : out;
}

function optionalDiscordRef(
  value: unknown,
  path: string,
  issues: ValidationIssue[]
): HumanRequestDiscordRef | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.push({ path, message: "must be a JSON object" });
    return undefined;
  }
  const channelId = optionalStringOrNull(value, "channel_id", issuesFor(path, issues));
  const threadId = optionalStringOrNull(value, "thread_id", issuesFor(path, issues));
  const messageId = optionalStringOrNull(value, "message_id", issuesFor(path, issues));
  const url = optionalStringOrNull(value, "url", issuesFor(path, issues));
  return {
    ...(channelId !== undefined ? { channel_id: channelId } : {}),
    ...(threadId !== undefined ? { thread_id: threadId } : {}),
    ...(messageId !== undefined ? { message_id: messageId } : {}),
    ...(url !== undefined ? { url } : {})
  };
}

function requireApprovalScope(
  value: unknown,
  path: string,
  issues: ValidationIssue[]
): HumanDecisionApprovalScope | undefined {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be a JSON object" });
    return undefined;
  }
  const action = requireString(value, "action", issuesFor(path, issues));
  const target = optionalStringOrNull(value, "target", issuesFor(path, issues));
  const singleUse = requireBoolean(value, "single_use", issuesFor(path, issues));
  const expiresAt = optionalIsoDateString(value, "expires_at", issuesFor(path, issues));
  const constraints = optionalStringArray(value, "constraints", issuesFor(path, issues));
  if (!action || singleUse === undefined) return undefined;
  return {
    action,
    ...(target !== undefined ? { target } : {}),
    single_use: singleUse,
    ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
    ...(constraints !== undefined ? { constraints } : {})
  };
}

function requireBoolean(
  input: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): boolean | undefined {
  const value = input[key];
  if (typeof value === "boolean") return value;
  issues.push({ path: key, message: "must be a boolean" });
  return undefined;
}

function issuesFor(path: string, issues: ValidationIssue[]) {
  return new Proxy(issues, {
    get(target, prop, receiver) {
      if (prop === "push") {
        return (issue: ValidationIssue) => target.push({ path: `${path}.${issue.path}`, message: issue.message });
      }
      return Reflect.get(target, prop, receiver);
    }
  }) as ValidationIssue[];
}
