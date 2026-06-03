import {
  fail,
  isRecord,
  ok,
  optionalJsonObject,
  optionalStringArray,
  requireEnum,
  requireIsoDateString,
  requireString,
  type JsonObject,
  type ValidationIssue,
  type ValidationResult
} from "./validation.js";

export const POLICY_DECISION_SCHEMA = "openclaw.agent.policy_decision.v1" as const;

export const POLICY_SUBJECT_KINDS = [
  "execution_job",
  "cas_runner_plan",
  "memory_action",
  "discord_delivery",
  "tool_action",
  "proactivity_action",
  "model_selection"
] as const;
export type PolicySubjectKind = (typeof POLICY_SUBJECT_KINDS)[number];

export const POLICY_DECISIONS = ["allow-once", "deny", "ask-human"] as const;
export type PolicyDecision = (typeof POLICY_DECISIONS)[number];

export const POLICY_RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type PolicyRiskLevel = (typeof POLICY_RISK_LEVELS)[number];

export interface PolicyDecisionRecord {
  schema: typeof POLICY_DECISION_SCHEMA;
  decision_id: string;
  subject_kind: PolicySubjectKind;
  subject_id: string;
  decision: PolicyDecision;
  risk_level: PolicyRiskLevel;
  reason: string;
  no_external_side_effects: true;
  risk_flags: string[];
  evaluated_at: string;
  metadata?: JsonObject;
}

export function validatePolicyDecisionRecord(
  input: unknown
): ValidationResult<PolicyDecisionRecord> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const schema = requireEnum(input, "schema", [POLICY_DECISION_SCHEMA], issues);
  const decisionId = requireString(input, "decision_id", issues);
  const subjectKind = requireEnum(input, "subject_kind", POLICY_SUBJECT_KINDS, issues);
  const subjectId = requireString(input, "subject_id", issues);
  const decision = requireEnum(input, "decision", POLICY_DECISIONS, issues);
  const riskLevel = requireEnum(input, "risk_level", POLICY_RISK_LEVELS, issues);
  const reason = requireString(input, "reason", issues);
  const noExternalSideEffects = requireTrue(input, "no_external_side_effects", issues);
  const riskFlags = requiredStringArray(input, "risk_flags", issues);
  const evaluatedAt = requireIsoDateString(input, "evaluated_at", issues);
  const metadata = optionalJsonObject(input, "metadata", issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({
    schema: schema!,
    decision_id: decisionId!,
    subject_kind: subjectKind!,
    subject_id: subjectId!,
    decision: decision!,
    risk_level: riskLevel!,
    reason: reason!,
    no_external_side_effects: noExternalSideEffects!,
    risk_flags: riskFlags!,
    evaluated_at: evaluatedAt!,
    ...(metadata !== undefined ? { metadata } : {})
  });
}

function requiredStringArray(
  input: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): string[] | undefined {
  const value = optionalStringArray(input, key, issues);
  if (!Object.hasOwn(input, key)) {
    issues.push({ path: key, message: "is required" });
    return undefined;
  }
  return value;
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
