import {
  fail,
  isRecord,
  ok,
  optionalJsonObject,
  optionalStringOrNull,
  requireIsoDateString,
  requireString,
  type JsonObject,
  type ValidationIssue,
  type ValidationResult
} from "./validation.js";
import type { GuardianApprovalDecision } from "./approval.js";

export const MEMORY_FABRIC_TARGETS = [
  "mem0_scope",
  "local_folder",
  "memory_wiki",
  "synced_folder",
  "prompt_handoff"
] as const;
export type MemoryFabricTarget = (typeof MEMORY_FABRIC_TARGETS)[number];

export const MEMORY_FABRIC_OPERATIONS = [
  "read",
  "propose_write",
  "commit_write",
  "handoff",
  "redact",
  "delete_request"
] as const;
export type MemoryFabricOperation = (typeof MEMORY_FABRIC_OPERATIONS)[number];

export const MEMORY_FABRIC_SENSITIVITIES = [
  "public",
  "internal",
  "private",
  "confidential",
  "secret"
] as const;
export type MemoryFabricSensitivity = (typeof MEMORY_FABRIC_SENSITIVITIES)[number];

export const MEMORY_FABRIC_REDACTION_STATES = ["none", "redacted"] as const;
export type MemoryFabricRedactionState = (typeof MEMORY_FABRIC_REDACTION_STATES)[number];

export const MEMORY_FABRIC_PROVENANCE_KINDS = [
  "conversation",
  "artifact",
  "file",
  "tool_result",
  "human_instruction",
  "derived_summary"
] as const;
export type MemoryFabricProvenanceKind = (typeof MEMORY_FABRIC_PROVENANCE_KINDS)[number];

export const MEMORY_FABRIC_DECISION_STATUSES = [
  "approved_stubbed",
  "denied_stubbed",
  "requires_human_stubbed"
] as const;
export type MemoryFabricDecisionStatus = (typeof MEMORY_FABRIC_DECISION_STATUSES)[number];

export interface MemoryFabricProvenance {
  source_kind: string;
  source_id?: string | null;
}

export interface MemoryFabricProposal {
  id: string;
  requested_by_agent_id: string;
  workspace_id: string;
  domain_id: string;
  project_id?: string | null;
  task_id?: string | null;
  correlation_id?: string | null;
  target: string;
  operation: string;
  scope?: string | null;
  sensitivity: string;
  redaction_state: string;
  provenance: MemoryFabricProvenance;
  content?: JsonObject;
  policy_profile?: string;
  created_at: string;
  no_external_write: true;
  metadata?: JsonObject;
}

export interface MemoryFabricPolicyDecision {
  id: string;
  proposal_id: string;
  decision: GuardianApprovalDecision;
  status: MemoryFabricDecisionStatus;
  reason: string;
  evaluated_at: string;
  no_external_write: true;
  human_escalation_required: boolean;
  risk_flags: string[];
  metadata?: JsonObject;
}

export interface MemoryFabricPolicyEvaluation {
  proposal: MemoryFabricProposal;
  decision: MemoryFabricPolicyDecision;
}

export function validateMemoryFabricProposal(
  input: unknown
): ValidationResult<MemoryFabricProposal> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const id = requireString(input, "id", issues);
  const requestedByAgentId = requireString(input, "requested_by_agent_id", issues);
  const workspaceId = requireString(input, "workspace_id", issues);
  const domainId = requireString(input, "domain_id", issues);
  const projectId = optionalStringOrNull(input, "project_id", issues);
  const taskId = optionalStringOrNull(input, "task_id", issues);
  const correlationId = optionalStringOrNull(input, "correlation_id", issues);
  const target = requireString(input, "target", issues);
  const operation = requireString(input, "operation", issues);
  const scope = optionalStringOrNull(input, "scope", issues);
  const sensitivity = requireString(input, "sensitivity", issues);
  const redactionState = requireString(input, "redaction_state", issues);
  const provenance = validateMemoryFabricProvenance(input.provenance);
  if (!provenance.ok) {
    for (const issue of provenance.issues) {
      issues.push({ path: `provenance.${issue.path}`, message: issue.message });
    }
  }
  const content = optionalJsonObject(input, "content", issues);
  const policyProfile =
    input.policy_profile === undefined
      ? undefined
      : requireString(input, "policy_profile", issues);
  const createdAt = requireIsoDateString(input, "created_at", issues);
  const noExternalWrite = requireTrue(input, "no_external_write", issues);
  const metadata = optionalJsonObject(input, "metadata", issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({
    id: id!,
    requested_by_agent_id: requestedByAgentId!,
    workspace_id: workspaceId!,
    domain_id: domainId!,
    ...(projectId !== undefined ? { project_id: projectId } : {}),
    ...(taskId !== undefined ? { task_id: taskId } : {}),
    ...(correlationId !== undefined ? { correlation_id: correlationId } : {}),
    target: target!,
    operation: operation!,
    ...(scope !== undefined ? { scope } : {}),
    sensitivity: sensitivity!,
    redaction_state: redactionState!,
    provenance: provenance.value!,
    ...(content !== undefined ? { content } : {}),
    ...(policyProfile !== undefined ? { policy_profile: policyProfile } : {}),
    created_at: createdAt!,
    no_external_write: noExternalWrite!,
    ...(metadata !== undefined ? { metadata } : {})
  });
}

export function validateMemoryFabricPolicyDecision(
  input: unknown
): ValidationResult<MemoryFabricPolicyDecision> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const id = requireString(input, "id", issues);
  const proposalId = requireString(input, "proposal_id", issues);
  const decision = requireKnownString(input, "decision", ["allow-once", "deny", "ask-human"], issues);
  const status = requireKnownString(input, "status", MEMORY_FABRIC_DECISION_STATUSES, issues);
  const reason = requireString(input, "reason", issues);
  const evaluatedAt = requireIsoDateString(input, "evaluated_at", issues);
  const noExternalWrite = requireTrue(input, "no_external_write", issues);
  const humanEscalationRequired = requireBoolean(input, "human_escalation_required", issues);
  const riskFlags = requireStringArray(input, "risk_flags", issues);
  const metadata = optionalJsonObject(input, "metadata", issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({
    id: id!,
    proposal_id: proposalId!,
    decision: decision!,
    status: status!,
    reason: reason!,
    evaluated_at: evaluatedAt!,
    no_external_write: noExternalWrite!,
    human_escalation_required: humanEscalationRequired!,
    risk_flags: riskFlags!,
    ...(metadata !== undefined ? { metadata } : {})
  });
}

export function validateMemoryFabricPolicyEvaluation(
  input: unknown
): ValidationResult<MemoryFabricPolicyEvaluation> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const proposal = validateMemoryFabricProposal(input.proposal);
  if (!proposal.ok) {
    for (const issue of proposal.issues) {
      issues.push({ path: `proposal.${issue.path}`, message: issue.message });
    }
  }
  const decision = validateMemoryFabricPolicyDecision(input.decision);
  if (!decision.ok) {
    for (const issue of decision.issues) {
      issues.push({ path: `decision.${issue.path}`, message: issue.message });
    }
  }

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({ proposal: proposal.value!, decision: decision.value! });
}

function validateMemoryFabricProvenance(
  input: unknown
): ValidationResult<MemoryFabricProvenance> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const sourceKind = requireString(input, "source_kind", issues);
  const sourceId = optionalStringOrNull(input, "source_id", issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({
    source_kind: sourceKind!,
    ...(sourceId !== undefined ? { source_id: sourceId } : {})
  });
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

function requireBoolean(
  input: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): boolean | undefined {
  if (typeof input[key] === "boolean") {
    return input[key] as boolean;
  }
  issues.push({ path: key, message: "must be a boolean" });
  return undefined;
}

function requireStringArray(
  input: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): string[] | undefined {
  const value = input[key];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  issues.push({ path: key, message: "must be an array of strings" });
  return undefined;
}

function requireKnownString<T extends string>(
  input: Record<string, unknown>,
  key: string,
  values: readonly T[],
  issues: ValidationIssue[]
): T | undefined {
  const value = input[key];
  if (typeof value === "string" && values.includes(value as T)) {
    return value as T;
  }
  issues.push({ path: key, message: `must be one of: ${values.join(", ")}` });
  return undefined;
}
