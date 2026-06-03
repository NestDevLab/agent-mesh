import {
  fail,
  isRecord,
  ok,
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
import type {
  OrchestrationStrategy,
  TaskLifecycleStatus,
  TaskPrivacy,
  TaskSeverity,
  TaskThreadDecision,
  TaskThreadReportPlan,
  TaskThreadSource
} from "./task-thread-report.js";

export const PROACTIVITY_TASK_THREAD_FLOW_SCHEMA =
  "openclaw.agent_os.proactivity_task_thread_flow.v1" as const;

export const PROACTIVITY_FINDING_EVENTS = [
  "new",
  "severity_changed",
  "status_changed",
  "stale_threshold_crossed",
  "resolved",
  "improvement_proposed",
  "unchanged"
] as const;
export type ProactivityFindingEvent = (typeof PROACTIVITY_FINDING_EVENTS)[number];

export const PROACTIVITY_FINDING_STATUSES = [
  "active",
  "waiting",
  "stale",
  "resolved",
  "suppressed",
  "needs_human",
  "reopened"
] as const;
export type ProactivityFindingStatus = (typeof PROACTIVITY_FINDING_STATUSES)[number];

export interface ProactivityFindingRecord {
  finding_key: string;
  title: string;
  summary: string;
  severity: TaskSeverity;
  privacy: TaskPrivacy;
  source: TaskThreadSource;
  event: ProactivityFindingEvent;
  status: ProactivityFindingStatus;
  observed_at: string;
  evidence: string[];
  domain_hint?: string | null;
  type_hint?: string | null;
  taskflow_path?: string | null;
  spec_path?: string | null;
  owner_agent_id?: string | null;
  existing_thread_id?: string | null;
  metadata?: JsonObject;
}

export interface ProactivitySuppressionDecision {
  suppressed: boolean;
  reason: string;
  cooldown_key: string;
}

export interface ProactivityTaskThreadFlowPlan {
  schema: typeof PROACTIVITY_TASK_THREAD_FLOW_SCHEMA;
  dry_run: true;
  finding: ProactivityFindingRecord;
  suppression: ProactivitySuppressionDecision;
  task_thread_plan: TaskThreadReportPlan;
  worker_strategy: OrchestrationStrategy;
  task_status: TaskLifecycleStatus;
  notify_in_discord: boolean;
  state_transition: {
    from: ProactivityFindingStatus;
    to: ProactivityFindingStatus;
  };
  audit_metadata?: JsonObject;
}

export function validateProactivityFindingRecord(
  input: unknown
): ValidationResult<ProactivityFindingRecord> {
  if (!isRecord(input)) return fail([{ path: "$", message: "must be a JSON object" }]);
  const issues: ValidationIssue[] = [];
  const findingKey = requireString(input, "finding_key", issues);
  const title = requireString(input, "title", issues);
  const summary = requireString(input, "summary", issues);
  const severity = requireEnum(input, "severity", ["info", "warning", "critical"] as const, issues);
  const privacy = requireEnum(input, "privacy", ["public_control_room", "internal", "sensitive"] as const, issues);
  const source = requireEnum(input, "source", ["human_request", "proactivity_finding", "taskflow", "manual_test", "worker_report"] as const, issues);
  const event = requireEnum(input, "event", PROACTIVITY_FINDING_EVENTS, issues);
  const status = requireEnum(input, "status", PROACTIVITY_FINDING_STATUSES, issues);
  const observedAt = requireIsoDateString(input, "observed_at", issues);
  const evidence = optionalStringArray(input, "evidence", issues);
  if (!Object.hasOwn(input, "evidence")) issues.push({ path: "evidence", message: "is required" });
  const domainHint = optionalStringOrNull(input, "domain_hint", issues);
  const typeHint = optionalStringOrNull(input, "type_hint", issues);
  const taskflowPath = optionalStringOrNull(input, "taskflow_path", issues);
  const specPath = optionalStringOrNull(input, "spec_path", issues);
  const ownerAgentId = optionalStringOrNull(input, "owner_agent_id", issues);
  const existingThreadId = optionalStringOrNull(input, "existing_thread_id", issues);
  const metadata = optionalJsonObject(input, "metadata", issues);
  if (issues.length > 0) return fail(issues);
  return ok({
    finding_key: findingKey!,
    title: title!,
    summary: summary!,
    severity: severity!,
    privacy: privacy!,
    source: source!,
    event: event!,
    status: status!,
    observed_at: observedAt!,
    evidence: evidence!,
    ...(domainHint !== undefined ? { domain_hint: domainHint } : {}),
    ...(typeHint !== undefined ? { type_hint: typeHint } : {}),
    ...(taskflowPath !== undefined ? { taskflow_path: taskflowPath } : {}),
    ...(specPath !== undefined ? { spec_path: specPath } : {}),
    ...(ownerAgentId !== undefined ? { owner_agent_id: ownerAgentId } : {}),
    ...(existingThreadId !== undefined ? { existing_thread_id: existingThreadId } : {}),
    ...(metadata !== undefined ? { metadata } : {})
  });
}
