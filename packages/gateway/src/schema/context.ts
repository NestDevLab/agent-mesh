import {
  fail,
  isRecord,
  ok,
  optionalStringArray,
  optionalStringOrNull,
  requireEnum,
  requireString,
  type ValidationIssue,
  type ValidationResult
} from "./validation.js";

export const CONTEXT_STATUSES = ["active", "inactive", "archived"] as const;
export type ContextStatus = (typeof CONTEXT_STATUSES)[number];

export const CONTEXT_TYPES = [
  "workspace",
  "personal",
  "business",
  "company",
  "project_or_venture",
  "project",
  "task"
] as const;

export type ContextType = (typeof CONTEXT_TYPES)[number];

export interface MeshContextRecord {
  id: string;
  type: ContextType;
  name: string;
  parent_id: string | null;
  owner_human?: string;
  policy_profile: string;
  memory_scopes?: string[];
  status: ContextStatus;
}

export function validateMeshContextRecord(input: unknown): ValidationResult<MeshContextRecord> {
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be a JSON object" }]);
  }

  const issues: ValidationIssue[] = [];
  const id = requireString(input, "id", issues);
  const type = requireEnum(input, "type", CONTEXT_TYPES, issues);
  const name = requireString(input, "name", issues);
  const parentId = optionalStringOrNull(input, "parent_id", issues);
  if (!Object.hasOwn(input, "parent_id")) {
    issues.push({ path: "parent_id", message: "is required and may be JSON null" });
  }
  const ownerHuman =
    input.owner_human === undefined
      ? undefined
      : requireString(input, "owner_human", issues);
  const policyProfile = requireString(input, "policy_profile", issues);
  const memoryScopes = optionalStringArray(input, "memory_scopes", issues);
  const status = requireEnum(input, "status", CONTEXT_STATUSES, issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({
    id: id!,
    type: type!,
    name: name!,
    parent_id: parentId!,
    ...(ownerHuman !== undefined ? { owner_human: ownerHuman } : {}),
    policy_profile: policyProfile!,
    ...(memoryScopes !== undefined ? { memory_scopes: memoryScopes } : {}),
    status: status!
  });
}
