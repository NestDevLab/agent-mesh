import {
  fail,
  isRecord,
  ok,
  optionalStringArray,
  requireEnum,
  requireIsoDateString,
  requireString,
  type ValidationIssue,
  type ValidationResult
} from "./validation.js";

export const MODEL_SELECTION_SCHEMA = "openclaw.agent.model_selection.v1" as const;

export const MODEL_PROFILE_TIERS = [
  "routine_fast",
  "balanced",
  "deep_reasoning",
  "specialist_coding",
  "safety_review",
  "local_private"
] as const;
export type ModelProfileTier = (typeof MODEL_PROFILE_TIERS)[number];

export const MODEL_REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ModelReasoningEffort = (typeof MODEL_REASONING_EFFORTS)[number];

export const MODEL_TASK_KINDS = [
  "triage",
  "research",
  "code_implementation",
  "code_review",
  "security_review",
  "memory",
  "backoffice",
  "design",
  "approval_review",
  "planning",
  "summary",
  "checklist"
] as const;
export type ModelTaskKind = (typeof MODEL_TASK_KINDS)[number];

export const TASK_COMPLEXITIES = ["low", "medium", "high"] as const;
export type TaskComplexity = (typeof TASK_COMPLEXITIES)[number];

export const TASK_RISKS = ["low", "medium", "high", "critical"] as const;
export type TaskRisk = (typeof TASK_RISKS)[number];

export const TASK_SENSITIVITIES = [
  "public",
  "internal",
  "private",
  "confidential",
  "secret"
] as const;
export type TaskSensitivity = (typeof TASK_SENSITIVITIES)[number];

export interface ModelSelectionRecord {
  schema: typeof MODEL_SELECTION_SCHEMA;
  event_id: string;
  created_at: string;
  agent_id: string;
  task_kind: ModelTaskKind;
  complexity: TaskComplexity;
  risk: TaskRisk;
  sensitivity: TaskSensitivity;
  selected_profile: ModelProfileTier;
  selected_model_alias: string;
  reasoning_effort: ModelReasoningEffort;
  fallback_profiles: ModelProfileTier[];
  approval_required: boolean;
  no_runtime_config_change: true;
  reason: string;
}

export function validateModelSelectionRecord(
  input: unknown
): ValidationResult<ModelSelectionRecord> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const schema = requireEnum(input, "schema", [MODEL_SELECTION_SCHEMA], issues);
  const eventId = requireString(input, "event_id", issues);
  const createdAt = requireIsoDateString(input, "created_at", issues);
  const agentId = requireString(input, "agent_id", issues);
  const taskKind = requireEnum(input, "task_kind", MODEL_TASK_KINDS, issues);
  const complexity = requireEnum(input, "complexity", TASK_COMPLEXITIES, issues);
  const risk = requireEnum(input, "risk", TASK_RISKS, issues);
  const sensitivity = requireEnum(input, "sensitivity", TASK_SENSITIVITIES, issues);
  const selectedProfile = requireEnum(
    input,
    "selected_profile",
    MODEL_PROFILE_TIERS,
    issues
  );
  const selectedModelAlias = requireString(input, "selected_model_alias", issues);
  const reasoningEffort = requireEnum(
    input,
    "reasoning_effort",
    MODEL_REASONING_EFFORTS,
    issues
  );
  const fallbackProfiles = optionalStringArray(input, "fallback_profiles", issues);
  if (!Object.hasOwn(input, "fallback_profiles")) {
    issues.push({ path: "fallback_profiles", message: "is required" });
  } else if (
    fallbackProfiles !== undefined &&
    !fallbackProfiles.every((profile) =>
      MODEL_PROFILE_TIERS.includes(profile as ModelProfileTier)
    )
  ) {
    issues.push({
      path: "fallback_profiles",
      message: `must only contain: ${MODEL_PROFILE_TIERS.join(", ")}`
    });
  }

  const approvalRequired = requireBoolean(input, "approval_required", issues);
  const noRuntimeConfigChange = requireTrue(input, "no_runtime_config_change", issues);
  const reason = requireString(input, "reason", issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({
    schema: schema!,
    event_id: eventId!,
    created_at: createdAt!,
    agent_id: agentId!,
    task_kind: taskKind!,
    complexity: complexity!,
    risk: risk!,
    sensitivity: sensitivity!,
    selected_profile: selectedProfile!,
    selected_model_alias: selectedModelAlias!,
    reasoning_effort: reasoningEffort!,
    fallback_profiles: fallbackProfiles as ModelProfileTier[],
    approval_required: approvalRequired!,
    no_runtime_config_change: noRuntimeConfigChange!,
    reason: reason!
  });
}

function requireBoolean(
  input: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): boolean | undefined {
  const value = input[key];
  if (typeof value === "boolean") {
    return value;
  }
  issues.push({ path: key, message: "must be a boolean" });
  return undefined;
}

function requireTrue(
  input: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): true | undefined {
  const value = input[key];
  if (value === true) {
    return true;
  }
  issues.push({ path: key, message: "must be true" });
  return undefined;
}
