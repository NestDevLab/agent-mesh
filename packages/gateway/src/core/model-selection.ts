import {
  MODEL_SELECTION_SCHEMA,
  type ModelProfileTier,
  type ModelReasoningEffort,
  type ModelSelectionRecord,
  type ModelTaskKind,
  type TaskComplexity,
  type TaskRisk,
  type TaskSensitivity
} from "../schema/model-selection.js";

export interface ModelSelectionInput {
  agent_id: string;
  agent_role?: string;
  workspace_id?: string;
  domain_id?: string;
  project_id?: string | null;
  task_id?: string | null;
  task_kind: ModelTaskKind;
  complexity: TaskComplexity;
  risk: TaskRisk;
  sensitivity: TaskSensitivity;
  external_side_effects_possible?: boolean;
  local_private_available?: boolean;
  created_at?: string;
}

export interface RunnerTeamSizingInput {
  task_kind: ModelTaskKind;
  complexity: TaskComplexity;
  risk?: TaskRisk;
  external_side_effects_possible?: boolean;
}

export interface RunnerTeamSizingRecommendation {
  orchestration: "none" | "one_worker" | "two_roles" | "three_plus_roles" | "design_review_first";
  roles: string[];
  approval_required: boolean;
  reason: string;
}

interface ModelProfileConfig {
  selected_model_alias: string;
  reasoning_effort: ModelReasoningEffort;
  fallback_profiles: ModelProfileTier[];
}

const PROFILE_CONFIG: Record<ModelProfileTier, ModelProfileConfig> = {
  routine_fast: {
    selected_model_alias: "routine-fast-stub",
    reasoning_effort: "low",
    fallback_profiles: ["balanced"]
  },
  balanced: {
    selected_model_alias: "balanced-stub",
    reasoning_effort: "medium",
    fallback_profiles: ["routine_fast"]
  },
  deep_reasoning: {
    selected_model_alias: "deep-reasoning-stub",
    reasoning_effort: "high",
    fallback_profiles: ["balanced", "safety_review"]
  },
  specialist_coding: {
    selected_model_alias: "codex-default",
    reasoning_effort: "medium",
    fallback_profiles: ["deep_reasoning", "balanced"]
  },
  safety_review: {
    selected_model_alias: "safety-review-stub",
    reasoning_effort: "high",
    fallback_profiles: ["deep_reasoning", "balanced"]
  },
  local_private: {
    selected_model_alias: "local-private-stub",
    reasoning_effort: "medium",
    fallback_profiles: ["safety_review", "balanced"]
  }
};

export function selectModelProfile(input: ModelSelectionInput): ModelSelectionRecord {
  const selectedProfile = selectProfileTier(input);
  const config = PROFILE_CONFIG[selectedProfile];
  const approvalRequired = requiresApproval(input, selectedProfile);

  return {
    schema: MODEL_SELECTION_SCHEMA,
    event_id: modelSelectionEventId(input),
    created_at: input.created_at ?? new Date().toISOString(),
    agent_id: input.agent_id,
    task_kind: input.task_kind,
    complexity: input.complexity,
    risk: input.risk,
    sensitivity: input.sensitivity,
    selected_profile: selectedProfile,
    selected_model_alias: config.selected_model_alias,
    reasoning_effort: config.reasoning_effort,
    fallback_profiles: config.fallback_profiles,
    approval_required: approvalRequired,
    no_runtime_config_change: true,
    reason: selectionReason(input, selectedProfile, approvalRequired)
  };
}

export function recommendRunnerTeamSize(
  input: RunnerTeamSizingInput
): RunnerTeamSizingRecommendation {
  if (input.task_kind !== "code_implementation") {
    return {
      orchestration: "none",
      roles: [],
      approval_required: false,
      reason: "runner team sizing only applies to code implementation tasks."
    };
  }

  if (input.external_side_effects_possible === true) {
    return {
      orchestration: "design_review_first",
      roles: ["architect", "reviewer_qa"],
      approval_required: true,
      reason: "External side effects require design/review before implementation."
    };
  }

  if (input.complexity === "high" || input.risk === "high" || input.risk === "critical") {
    return {
      orchestration: "three_plus_roles",
      roles: ["architect", "implementer", "reviewer_qa", "security_reviewer"],
      approval_required: input.risk === "critical",
      reason: "High complexity or risk should use architect, implementation, QA, and safety roles."
    };
  }

  if (input.complexity === "medium") {
    return {
      orchestration: "two_roles",
      roles: ["implementer", "reviewer_qa"],
      approval_required: false,
      reason: "Medium implementation should use implementer plus reviewer/QA."
    };
  }

  return {
    orchestration: "one_worker",
    roles: ["implementer"],
    approval_required: false,
    reason: "Low complexity implementation can use one scoped runner worker when safe."
  };
}

function selectProfileTier(input: ModelSelectionInput): ModelProfileTier {
  if (isPrivateOrSecret(input.sensitivity) && input.local_private_available !== false) {
    return "local_private";
  }

  if (isSecurityOrApproval(input) || input.risk === "high" || input.risk === "critical") {
    return "safety_review";
  }

  if (input.task_kind === "code_implementation") {
    return "specialist_coding";
  }

  if (input.task_kind === "code_review" || input.complexity === "high") {
    return "deep_reasoning";
  }

  if (
    input.complexity === "low" &&
    input.risk === "low" &&
    input.external_side_effects_possible !== true &&
    isRoutineTask(input.task_kind)
  ) {
    return "routine_fast";
  }

  return defaultProfileForAgent(input);
}

function defaultProfileForAgent(input: ModelSelectionInput): ModelProfileTier {
  if (input.agent_id === "agent.security" || input.agent_role === "security") {
    return "safety_review";
  }

  if (input.agent_id === "agent.software_engineer" || isSoftwareRole(input.agent_role)) {
    return input.task_kind === "summary" ? "balanced" : "deep_reasoning";
  }

  return "balanced";
}

function requiresApproval(
  input: ModelSelectionInput,
  selectedProfile: ModelProfileTier
): boolean {
  if (input.external_side_effects_possible === true) {
    return true;
  }
  if (input.risk === "critical") {
    return true;
  }
  if (isPrivateOrSecret(input.sensitivity) && selectedProfile !== "local_private") {
    return true;
  }
  return false;
}

function selectionReason(
  input: ModelSelectionInput,
  selectedProfile: ModelProfileTier,
  approvalRequired: boolean
): string {
  const approvalSuffix = approvalRequired ? " Approval is required by policy." : "";

  switch (selectedProfile) {
    case "local_private":
      return `Sensitive ${input.sensitivity} context should prefer a local/private profile.${approvalSuffix}`;
    case "safety_review":
      return `Security, approval, or high-risk work should use the safety review profile.${approvalSuffix}`;
    case "specialist_coding":
      return `Code implementation should use the specialist coding profile with runner-aware guardrails.${approvalSuffix}`;
    case "deep_reasoning":
      return `High complexity or code review work should use deeper reasoning.${approvalSuffix}`;
    case "routine_fast":
      return `Low-risk routine work without external side effects can use a fast routine profile.${approvalSuffix}`;
    case "balanced":
      return `Normal planning or coordination can use the balanced profile.${approvalSuffix}`;
  }
}

function modelSelectionEventId(input: ModelSelectionInput): string {
  const parts = [
    "model_selection",
    input.agent_id,
    input.task_kind,
    input.complexity,
    input.risk,
    input.sensitivity,
    input.task_id ?? input.project_id ?? input.domain_id ?? input.workspace_id ?? "local"
  ];

  return parts.map(sanitizeIdPart).join("_");
}

function sanitizeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function isSecurityOrApproval(input: ModelSelectionInput): boolean {
  return (
    input.task_kind === "security_review" ||
    input.task_kind === "approval_review" ||
    input.agent_id === "agent.security" ||
    input.agent_role === "security"
  );
}

function isPrivateOrSecret(sensitivity: TaskSensitivity): boolean {
  return sensitivity === "private" || sensitivity === "confidential" || sensitivity === "secret";
}

function isRoutineTask(taskKind: ModelTaskKind): boolean {
  return taskKind === "triage" || taskKind === "summary" || taskKind === "checklist";
}

function isSoftwareRole(role: string | undefined): boolean {
  return role === "software_engineer" || role === "software_engineering";
}
