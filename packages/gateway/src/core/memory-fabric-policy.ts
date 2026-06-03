import {
  MEMORY_FABRIC_OPERATIONS,
  MEMORY_FABRIC_PROVENANCE_KINDS,
  MEMORY_FABRIC_REDACTION_STATES,
  MEMORY_FABRIC_SENSITIVITIES,
  MEMORY_FABRIC_TARGETS,
  type MemoryFabricPolicyDecision,
  type MemoryFabricPolicyEvaluation,
  type MemoryFabricProposal
} from "../schema/memory-fabric.js";
import { validateMemoryFabricProposal } from "../schema/memory-fabric.js";
import type { JsonObject } from "../schema/validation.js";
import { isoNow, newEventId, type StoreClock } from "./ndjson-store.js";
import { MemoryFabricStore } from "./memory-fabric-store.js";

export interface MemoryFabricPolicyGateOptions {
  stateDir?: string;
  clock?: StoreClock;
  knownScopes?: readonly string[];
  agentDomainAccess?: Readonly<Record<string, readonly string[]>>;
}

export class MemoryFabricPolicyGate {
  private readonly store: MemoryFabricStore;
  private readonly clock?: StoreClock;
  private readonly knownScopes: readonly string[];
  private readonly agentDomainAccess: Readonly<Record<string, readonly string[]>>;

  constructor(options: MemoryFabricPolicyGateOptions = {}) {
    this.store = new MemoryFabricStore(options);
    this.clock = options.clock;
    this.knownScopes = options.knownScopes ?? DEFAULT_KNOWN_SCOPES;
    this.agentDomainAccess = options.agentDomainAccess ?? {};
  }

  async evaluate(input: unknown): Promise<MemoryFabricPolicyEvaluation> {
    const validation = validateMemoryFabricProposal(input);
    if (!validation.ok) {
      throw new Error(
        `Invalid Memory Fabric proposal: ${validation.issues
          .map((issue) => `${issue.path} ${issue.message}`)
          .join("; ")}`
      );
    }

    const proposal = validation.value!;
    const decision = selectMemoryFabricPolicyDecision(proposal, {
      now: isoNow(this.clock),
      knownScopes: this.knownScopes,
      agentDomainAccess: this.agentDomainAccess
    });
    const evaluation = { proposal, decision };
    await this.store.append(evaluation);
    return evaluation;
  }
}

export function selectMemoryFabricPolicyDecision(
  proposal: MemoryFabricProposal,
  options: {
    now?: string;
    knownScopes?: readonly string[];
    agentDomainAccess?: Readonly<Record<string, readonly string[]>>;
  } = {}
): MemoryFabricPolicyDecision {
  const now = options.now ?? isoNow();
  const knownScopes = options.knownScopes ?? DEFAULT_KNOWN_SCOPES;
  const agentDomainAccess = options.agentDomainAccess ?? {};
  const riskFlags = memoryFabricRiskFlags(proposal, knownScopes, agentDomainAccess);
  const selected = selectDecision(proposal, riskFlags);

  return {
    id: newEventId("memory_policy_decision"),
    proposal_id: proposal.id,
    decision: selected.decision,
    status: selected.status,
    reason: selected.reason,
    evaluated_at: now,
    no_external_write: true,
    human_escalation_required: selected.decision === "ask-human",
    risk_flags: riskFlags,
    metadata: {
      stub_only: true,
      no_real_mem0_wiki_folder_discord_or_cas_adapters: true,
      scope_breadth: scopeBreadth(proposal.scope ?? null),
      target_write_stubbed: selected.decision !== "deny"
    }
  };
}

export function memoryFabricRiskFlags(
  proposal: MemoryFabricProposal,
  knownScopes: readonly string[] = DEFAULT_KNOWN_SCOPES,
  agentDomainAccess: Readonly<Record<string, readonly string[]>> = {}
): string[] {
  const flags = ["memory_fabric", "stub-only", "no-external-write"];

  if (proposal.scope === undefined || proposal.scope === null || proposal.scope.trim() === "") {
    flags.push("unscoped");
  } else if (!isKnownScope(proposal.scope, knownScopes)) {
    flags.push("unknown-scope");
  } else {
    flags.push(`${scopeBreadth(proposal.scope)}-scope`);
  }

  if (!isKnownTarget(proposal.target)) {
    flags.push("unknown-target");
  }
  if (!isKnownOperation(proposal.operation)) {
    flags.push("unknown-operation");
  }
  if (!isKnownSensitivity(proposal.sensitivity)) {
    flags.push("unknown-sensitivity");
  }
  if (!isKnownRedactionState(proposal.redaction_state)) {
    flags.push("unknown-redaction-state");
  }
  if (!isKnownProvenanceKind(proposal.provenance.source_kind)) {
    flags.push("unknown-provenance");
  }

  if (proposal.sensitivity === "secret" && proposal.redaction_state !== "redacted") {
    flags.push("secret-unredacted");
  }
  if (containsObviousSecret(proposal.content ?? {}) || containsObviousSecret(proposal.metadata ?? {})) {
    flags.push("obvious-secret-shaped-field");
  }
  if (proposal.operation === "delete_request") {
    flags.push("delete-forget-request");
  }
  if (isDurableSharedWrite(proposal)) {
    flags.push("durable-shared-write");
  }
  if (isSameDomainLowSensitivityProposal(proposal)) {
    flags.push("same-domain-low-sensitivity-proposal");
  }
  if (!agentCanAccessDomain(proposal, agentDomainAccess)) {
    flags.push("agent-domain-not-enabled");
  }

  return flags;
}

function selectDecision(
  proposal: MemoryFabricProposal,
  riskFlags: readonly string[]
): {
  decision: "allow-once" | "deny" | "ask-human";
  status: "approved_stubbed" | "denied_stubbed" | "requires_human_stubbed";
  reason: string;
} {
  if (riskFlags.includes("unscoped")) {
    return denied("Memory Fabric proposal denied because the request is unscoped.");
  }
  if (
    riskFlags.includes("unknown-target") ||
    riskFlags.includes("unknown-scope") ||
    riskFlags.includes("unknown-operation") ||
    riskFlags.includes("unknown-sensitivity") ||
    riskFlags.includes("unknown-redaction-state") ||
    riskFlags.includes("unknown-provenance")
  ) {
    return denied("Memory Fabric proposal denied because target, scope, or classification is unknown.");
  }
  if (riskFlags.includes("agent-domain-not-enabled")) {
    return denied("Memory Fabric proposal denied because the requester is not enabled for this domain.");
  }
  if (
    riskFlags.includes("secret-unredacted") ||
    riskFlags.includes("obvious-secret-shaped-field")
  ) {
    return denied("Memory Fabric proposal denied because secret content is not redacted.");
  }
  if (riskFlags.includes("delete-forget-request")) {
    return askHuman("Memory Fabric delete/forget requests require human approval.");
  }
  if (riskFlags.includes("durable-shared-write")) {
    return askHuman("Durable shared memory writes require human approval in the stub policy.");
  }
  if (riskFlags.includes("same-domain-low-sensitivity-proposal")) {
    return {
      decision: "allow-once",
      status: "approved_stubbed",
      reason: "Same-domain low-sensitivity memory proposal allowed once as proposal-only stub."
    };
  }

  if (proposal.scope?.startsWith("agent-private.")) {
    return {
      decision: "allow-once",
      status: "approved_stubbed",
      reason: "Agent-private memory action allowed once as record-only stub."
    };
  }

  return askHuman("Memory Fabric proposal requires human review by default.");
}

function denied(reason: string): {
  decision: "deny";
  status: "denied_stubbed";
  reason: string;
} {
  return { decision: "deny", status: "denied_stubbed", reason };
}

function askHuman(reason: string): {
  decision: "ask-human";
  status: "requires_human_stubbed";
  reason: string;
} {
  return { decision: "ask-human", status: "requires_human_stubbed", reason };
}

function isSameDomainLowSensitivityProposal(proposal: MemoryFabricProposal): boolean {
  return (
    proposal.operation === "propose_write" &&
    (proposal.sensitivity === "public" || proposal.sensitivity === "internal") &&
    (proposal.scope === proposal.domain_id || proposal.scope?.startsWith("project.") === true)
  );
}

function isDurableSharedWrite(proposal: MemoryFabricProposal): boolean {
  return (
    proposal.operation === "commit_write" &&
    (proposal.target === "memory_wiki" ||
      proposal.scope?.startsWith("domain.") === true ||
      proposal.scope?.startsWith("project.") === true)
  );
}

function scopeBreadth(scope: string | null): "unscoped" | "agent-private" | "project" | "domain" | "workspace" {
  if (scope === null || scope.trim() === "") {
    return "unscoped";
  }
  if (scope.startsWith("agent-private.")) {
    return "agent-private";
  }
  if (scope.startsWith("project.")) {
    return "project";
  }
  if (scope.startsWith("domain.")) {
    return "domain";
  }
  return "workspace";
}

function isKnownScope(scope: string, knownScopes: readonly string[]): boolean {
  return knownScopes.includes(scope) || scope.startsWith("project.") || scope.startsWith("agent-private.");
}

function isKnownTarget(value: string): boolean {
  return (MEMORY_FABRIC_TARGETS as readonly string[]).includes(value);
}

function isKnownOperation(value: string): boolean {
  return (MEMORY_FABRIC_OPERATIONS as readonly string[]).includes(value);
}

function isKnownSensitivity(value: string): boolean {
  return (MEMORY_FABRIC_SENSITIVITIES as readonly string[]).includes(value);
}

function isKnownRedactionState(value: string): boolean {
  return (MEMORY_FABRIC_REDACTION_STATES as readonly string[]).includes(value);
}

function isKnownProvenanceKind(value: string): boolean {
  return (MEMORY_FABRIC_PROVENANCE_KINDS as readonly string[]).includes(value);
}

function agentCanAccessDomain(
  proposal: MemoryFabricProposal,
  access: Readonly<Record<string, readonly string[]>>
): boolean {
  const configuredDomains = access[proposal.requested_by_agent_id];
  return configuredDomains === undefined || configuredDomains.includes(proposal.domain_id);
}

function containsObviousSecret(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsObviousSecret);
  }

  if (value === null || typeof value !== "object") {
    return false;
  }

  return Object.entries(value as JsonObject).some(([key, nested]) => {
    const normalized = key.toLowerCase();
    if (
      /(api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|private[_-]?key)/.test(
        normalized
      ) &&
      typeof nested === "string" &&
      nested.length > 0 &&
      !/^\[redacted\]$/i.test(nested)
    ) {
      return true;
    }
    return containsObviousSecret(nested);
  });
}

const DEFAULT_KNOWN_SCOPES = [
  "workspace.operational_preferences",
  "workspace.personal_private",
  "domain.personal",
  "domain.itermodus",
  "domain.nestdev",
  "domain.tirrenia",
  "domain.drassil"
] as const;
