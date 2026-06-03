import {
  fail,
  isRecord,
  ok,
  optionalStringArray,
  requireEnum,
  requireString,
  type ValidationIssue,
  type ValidationResult
} from "./validation.js";

export const AGENT_STATUSES = ["simulated", "placeholder", "offline", "online"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export interface MeshAgentRecord {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  phase_1_active: boolean;
  capabilities: string[];
  enabled_contexts?: string[];
  allow_self_messages?: boolean;
}

export function validateMeshAgentRecord(input: unknown): ValidationResult<MeshAgentRecord> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const id = requireString(input, "id", issues);
  const name = requireString(input, "name", issues);
  const role = requireString(input, "role", issues);
  const status = requireEnum(input, "status", AGENT_STATUSES, issues);
  const phase1Active = input.phase_1_active;
  if (typeof phase1Active !== "boolean") {
    issues.push({ path: "phase_1_active", message: "must be a boolean" });
  }
  const capabilities = optionalStringArray(input, "capabilities", issues);
  if (!Object.hasOwn(input, "capabilities")) {
    issues.push({ path: "capabilities", message: "is required" });
  }
  const enabledContexts = optionalStringArray(input, "enabled_contexts", issues);
  const allowSelfMessages = input.allow_self_messages;
  if (allowSelfMessages !== undefined && typeof allowSelfMessages !== "boolean") {
    issues.push({ path: "allow_self_messages", message: "must be a boolean" });
  }

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({
    id: id!,
    name: name!,
    role: role!,
    status: status!,
    phase_1_active: phase1Active as boolean,
    capabilities: capabilities!,
    ...(enabledContexts !== undefined ? { enabled_contexts: enabledContexts } : {}),
    ...(allowSelfMessages !== undefined
      ? { allow_self_messages: allowSelfMessages as boolean }
      : {})
  });
}
