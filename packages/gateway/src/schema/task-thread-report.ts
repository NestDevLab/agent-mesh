export type TaskThreadSource =
  | "human_request"
  | "proactivity_finding"
  | "taskflow"
  | "manual_test"
  | "worker_report";

export type TaskSeverity = "info" | "warning" | "critical";
export type TaskPrivacy = "public_control_room" | "internal" | "sensitive";
export type TaskLifecycleStatus =
  | "opened"
  | "progress"
  | "blocked"
  | "approval_needed"
  | "completed";

export type DiscordInventoryChannelType = "text" | "forum" | "thread";
export type DiscordThreadStatus = "open" | "closed" | "archived";

export type TaskThreadDecision =
  | "reuse_existing_thread"
  | "create_thread_in_existing_channel"
  | "propose_new_channel"
  | "blocked_needs_human_mapping";

export type OrchestrationStrategy = "internal" | "discord_bot_to_bot" | "hybrid";

export type TaskThreadLifecycleEvent =
  | "task_opened"
  | "routing_selected"
  | "worker_assigned"
  | "progress"
  | "blocker"
  | "approval_request"
  | "completion_claim"
  | "verification_summary"
  | "retrospective";

export interface TaskThreadTaskInput {
  id?: string;
  title: string;
  summary?: string;
  source: TaskThreadSource;
  domainHint?: string;
  typeHint?: string;
  severity?: TaskSeverity;
  privacy?: TaskPrivacy;
  lifecycle?: {
    status?: TaskLifecycleStatus;
    evidence?: string[];
    blocker?: string;
    nextAction?: string;
  };
  links?: {
    taskflowPath?: string;
    specPath?: string;
    findingId?: string;
    parentThreadId?: string;
  };
}

export interface DiscordInventoryThreadMetadata {
  parentChannelId: string;
  title: string;
  status?: DiscordThreadStatus;
}

export interface DiscordInventoryChannel {
  id: string;
  name: string;
  type: DiscordInventoryChannelType;
  parentId?: string;
  topic?: string;
  archived?: boolean;
  threadMetadata?: DiscordInventoryThreadMetadata;
}

export interface DiscordInventoryCategory {
  id: string;
  name: string;
  channels: DiscordInventoryChannel[];
}

export interface DiscordPlacementInventory {
  categories: DiscordInventoryCategory[];
}

export interface TaskThreadReportRules {
  allowNewThreadProposal: boolean;
  allowNewChannelProposal: boolean;
  preferredTaskIdPrefix?: "AM" | "AO" | "OC" | "CC";
  maxThreadTitleLength?: number;
}

export interface TaskThreadReportDryRunInput {
  task: TaskThreadTaskInput;
  discordInventory: DiscordPlacementInventory;
  rules?: Partial<TaskThreadReportRules>;
}

export interface TaskThreadClassification {
  domain: string;
  taskType: string;
  confidence: number;
  reasons: string[];
}

export interface TaskThreadPlacementRef {
  id?: string;
  name?: string;
  title?: string;
  source: "existing" | "proposed";
}

export interface TaskThreadPlacementPlan {
  decision: TaskThreadDecision;
  category?: TaskThreadPlacementRef;
  channel?: TaskThreadPlacementRef;
  thread?: TaskThreadPlacementRef;
  rationale: string[];
  needsApproval: boolean;
  approvalReason?: string;
}

export interface TaskThreadOrchestrationPlan {
  strategy: OrchestrationStrategy;
  allowedStrategies: OrchestrationStrategy[];
  rationale: string[];
}

export interface TaskThreadMessagePlanItem {
  lifecycleEvent: TaskThreadLifecycleEvent;
  target: "task_thread" | "request_channel";
  send: false;
  body: string;
  idempotencyKey: string;
}

export interface TaskThreadAuditPreviewItem {
  type: "agent_os.task_thread_report.dry_run";
  taskId: string;
  placementDecision: TaskThreadDecision;
  strategy: OrchestrationStrategy;
  timestamp?: string;
}

export interface TaskThreadReportPlan {
  dryRun: true;
  sideEffects: [];
  taskId: string;
  classification: TaskThreadClassification;
  placement: TaskThreadPlacementPlan;
  orchestration: TaskThreadOrchestrationPlan;
  messagePlan: TaskThreadMessagePlanItem[];
  auditPreview: TaskThreadAuditPreviewItem[];
  warnings: string[];
}
