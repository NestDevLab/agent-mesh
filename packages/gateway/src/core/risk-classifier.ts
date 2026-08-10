import {
  POLICY_DECISION_SCHEMA,
  type PolicyDecision,
  type PolicyDecisionRecord,
  type PolicyRiskLevel,
  type PolicySubjectKind
} from "../schema/policy-decision.js";
import type { JsonObject } from "../schema/validation.js";
import { isoNow, newEventId, type StoreClock } from "./ndjson-store.js";

export type PolicySensitivity = "public" | "internal" | "private" | "confidential" | "secret";
export type PolicyOperationReversibility =
  | "reversible"
  | "partially_reversible"
  | "irreversible";

export interface PolicyRiskInput {
  subject_kind: PolicySubjectKind;
  subject_id: string;
  sensitivity?: PolicySensitivity;
  external_side_effects?: boolean;
  no_external_side_effects?: boolean;
  target?: string;
  destination?: string;
  cost_tier?: "none" | "low" | "medium" | "high";
  model_tier?: string;
  tool_capability?: string;
  domain_id?: string;
  project_id?: string | null;
  operation_reversibility?: PolicyOperationReversibility;
  explicitly_requested?: boolean;
  redaction_state?: "none" | "redacted";
  metadata?: JsonObject;
}

export interface PolicyRiskClassification {
  risk_level: PolicyRiskLevel;
  risk_flags: string[];
}

export function classifyPolicyRisk(input: PolicyRiskInput): PolicyRiskClassification {
  const flags = riskFlagsFor(input);

  if (
    flags.includes("external-side-effects-requested") ||
    flags.includes("no-external-side-effects-not-affirmed") ||
    flags.includes("secret-unredacted")
  ) {
    return { risk_level: "critical", risk_flags: flags };
  }

  if (
    flags.includes("confidential") ||
    flags.includes("secret") ||
    flags.includes("write-capable-tool") ||
    flags.includes("irreversible-operation") ||
    flags.includes("high-cost-or-model-tier")
  ) {
    return { risk_level: "high", risk_flags: flags };
  }

  if (
    flags.includes("private") ||
    flags.includes("public-or-staff-destination") ||
    flags.includes("partially-reversible-operation") ||
    flags.includes("not-explicitly-requested") ||
    flags.includes("durable-memory-target")
  ) {
    return { risk_level: "medium", risk_flags: flags };
  }

  return { risk_level: "low", risk_flags: flags };
}

export function createPolicyDecisionRecord(
  input: PolicyRiskInput,
  options: { clock?: StoreClock } = {}
): PolicyDecisionRecord {
  const classification = classifyPolicyRisk(input);
  const decision = decisionFor(classification.risk_level);

  return {
    schema: POLICY_DECISION_SCHEMA,
    decision_id: newEventId("policy_decision"),
    subject_kind: input.subject_kind,
    subject_id: input.subject_id,
    decision,
    risk_level: classification.risk_level,
    reason: reasonFor(decision, classification),
    no_external_side_effects: true,
    risk_flags: classification.risk_flags,
    evaluated_at: isoNow(options.clock),
    metadata: {
      stub_only: true,
      no_real_runner_discord_memory_cron_or_tool_side_effects: true,
      ...(input.domain_id !== undefined ? { domain_id: input.domain_id } : {}),
      ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
      ...(input.metadata ?? {})
    }
  };
}

function decisionFor(riskLevel: PolicyRiskLevel): PolicyDecision {
  if (riskLevel === "critical") {
    return "deny";
  }
  if (riskLevel === "high" || riskLevel === "medium") {
    return "ask-human";
  }
  return "allow-once";
}

function reasonFor(
  decision: PolicyDecision,
  classification: PolicyRiskClassification
): string {
  if (decision === "deny") {
    return "Policy denied the action because the stub requires no external side effects.";
  }
  if (decision === "ask-human") {
    return `Policy requires human review for ${classification.risk_level}-risk stub action.`;
  }
  return "Policy allows one local stub-only record with no external side effects.";
}

function riskFlagsFor(input: PolicyRiskInput): string[] {
  const flags = [
    input.subject_kind,
    "stub-only",
    "local-record-only",
    "no-external-side-effects-enforced"
  ];

  if (input.no_external_side_effects !== true) {
    flags.push("no-external-side-effects-not-affirmed");
  }
  if (input.external_side_effects === true) {
    flags.push("external-side-effects-requested");
  }

  if (input.sensitivity !== undefined) {
    flags.push(input.sensitivity);
  }
  if (input.sensitivity === "secret" && input.redaction_state !== "redacted") {
    flags.push("secret-unredacted");
  }
  if (input.destination === "discord" || input.destination === "public" || input.destination === "staff") {
    flags.push("public-or-staff-destination");
  }
  if (input.target === "memory_wiki" || input.target === "synced_folder" || input.target === "shared_folder") {
    flags.push("durable-memory-target");
  }
  if (/write|send|execute|restart|deploy|publish|commit|push/i.test(input.tool_capability ?? "")) {
    flags.push("write-capable-tool");
  }
  if (input.operation_reversibility === "irreversible") {
    flags.push("irreversible-operation");
  }
  if (input.operation_reversibility === "partially_reversible") {
    flags.push("partially-reversible-operation");
  }
  if (input.cost_tier === "high" || /deep|safety|specialist|high/i.test(input.model_tier ?? "")) {
    flags.push("high-cost-or-model-tier");
  }
  if (input.explicitly_requested !== true) {
    flags.push("not-explicitly-requested");
  }

  return Array.from(new Set(flags));
}
