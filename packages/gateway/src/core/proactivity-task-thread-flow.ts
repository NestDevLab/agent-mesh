import type { DiscordPlacementInventory, TaskLifecycleStatus } from "../schema/task-thread-report.js";
import type {
  ProactivityFindingRecord,
  ProactivityTaskThreadFlowPlan
} from "../schema/proactivity-task-thread-flow.js";
import {
  PROACTIVITY_TASK_THREAD_FLOW_SCHEMA,
  validateProactivityFindingRecord
} from "../schema/proactivity-task-thread-flow.js";
import { planTaskThreadReportDryRun } from "./task-thread-reporter.js";

export interface PlanProactivityTaskThreadFlowInput {
  finding: ProactivityFindingRecord;
  discordInventory: DiscordPlacementInventory;
  cooldownActive?: boolean;
}

export function planProactivityTaskThreadFlow(
  input: PlanProactivityTaskThreadFlowInput
): ProactivityTaskThreadFlowPlan {
  const validation = validateProactivityFindingRecord(input.finding);
  if (!validation.ok) {
    throw new Error(
      `Invalid ProactivityFindingRecord: ${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join(", ")}`
    );
  }

  const suppression = decideSuppression(input.finding, Boolean(input.cooldownActive));
  const taskStatus = mapTaskStatus(input.finding);
  const taskThreadPlan = planTaskThreadReportDryRun({
    task: {
      id: input.finding.existing_thread_id ? undefined : undefined,
      title: input.finding.title,
      summary: input.finding.summary,
      source: input.finding.source,
      domainHint: input.finding.domain_hint ?? undefined,
      typeHint: input.finding.type_hint ?? undefined,
      severity: input.finding.severity,
      privacy: input.finding.privacy,
      lifecycle: {
        status: taskStatus,
        evidence: input.finding.evidence
      },
      links: {
        taskflowPath: input.finding.taskflow_path ?? undefined,
        specPath: input.finding.spec_path ?? undefined,
        findingId: input.finding.finding_key,
        parentThreadId: input.finding.existing_thread_id ?? undefined
      }
    },
    discordInventory: input.discordInventory
  });

  const nextStatus = suppression.suppressed
    ? "suppressed"
    : input.finding.event === "resolved"
      ? "resolved"
      : input.finding.event === "stale_threshold_crossed"
        ? "stale"
        : input.finding.status;

  return {
    schema: PROACTIVITY_TASK_THREAD_FLOW_SCHEMA,
    dry_run: true,
    finding: input.finding,
    suppression,
    task_thread_plan: taskThreadPlan,
    worker_strategy: taskThreadPlan.orchestration.strategy,
    task_status: taskStatus,
    notify_in_discord: !suppression.suppressed,
    state_transition: {
      from: input.finding.status,
      to: nextStatus
    },
    audit_metadata: {
      finding_key: input.finding.finding_key,
      event: input.finding.event,
      placement_decision: taskThreadPlan.placement.decision
    }
  };
}

function decideSuppression(
  finding: ProactivityFindingRecord,
  cooldownActive: boolean
): ProactivityTaskThreadFlowPlan["suppression"] {
  const cooldownKey = `finding:${finding.finding_key}:${finding.severity}:${finding.status}`;
  if (finding.event === "unchanged" || cooldownActive) {
    return {
      suppressed: true,
      reason: cooldownActive
        ? "cooldown active for unchanged finding"
        : "unchanged finding event is suppressed",
      cooldown_key: cooldownKey
    };
  }

  return {
    suppressed: false,
    reason: "finding changed in a way that may require a visible task-thread update",
    cooldown_key: cooldownKey
  };
}

function mapTaskStatus(finding: ProactivityFindingRecord): TaskLifecycleStatus {
  if (finding.event === "resolved" || finding.status === "resolved") return "completed";
  if (finding.status === "needs_human") return "approval_needed";
  if (finding.status === "waiting" || finding.status === "stale") return "blocked";
  return "opened";
}
