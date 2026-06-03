export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonArray = JsonValue[];

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  issues: ValidationIssue[];
}

export function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value, issues: [] };
}

export function fail<T = never>(issues: ValidationIssue[]): ValidationResult<T> {
  return { ok: false, issues };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }

  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      return Array.isArray(value)
        ? value.every(isJsonValue)
        : isJsonObject(value);
    default:
      return false;
  }
}

export function requireString(
  input: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): string | undefined {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    issues.push({ path: key, message: "must be a non-empty string" });
    return undefined;
  }
  return value;
}

export function optionalStringOrNull(
  input: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): string | null | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === "string") {
    return value;
  }
  issues.push({ path: key, message: "must be a string or JSON null" });
  return undefined;
}

export function requireInteger(
  input: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): number | undefined {
  const value = input[key];
  if (!Number.isInteger(value)) {
    issues.push({ path: key, message: "must be an integer" });
    return undefined;
  }
  return value as number;
}

export function requireEnum<T extends string>(
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

export function optionalEnum<T extends string>(
  input: Record<string, unknown>,
  key: string,
  values: readonly T[],
  issues: ValidationIssue[]
): T | undefined {
  if (input[key] === undefined) {
    return undefined;
  }
  return requireEnum(input, key, values, issues);
}

export function optionalJsonObject(
  input: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): JsonObject | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (isJsonObject(value)) {
    return value;
  }
  issues.push({ path: key, message: "must be a JSON object" });
  return undefined;
}

export function optionalStringArray(
  input: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): string[] | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  issues.push({ path: key, message: "must be an array of strings" });
  return undefined;
}

export function optionalIsoDateString(
  input: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): string | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return value;
  }
  issues.push({ path: key, message: "must be an ISO-8601 date string" });
  return undefined;
}

export function requireIsoDateString(
  input: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[]
): string | undefined {
  const value = requireString(input, key, issues);
  if (value !== undefined && Number.isNaN(Date.parse(value))) {
    issues.push({ path: key, message: "must be an ISO-8601 date string" });
  }
  return value;
}
