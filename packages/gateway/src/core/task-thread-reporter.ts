import type {
  DiscordInventoryCategory,
  DiscordInventoryChannel,
  OrchestrationStrategy,
  TaskThreadClassification,
  TaskThreadDecision,
  TaskThreadMessagePlanItem,
  TaskThreadOrchestrationPlan,
  TaskThreadPlacementPlan,
  TaskThreadReportDryRunInput,
  TaskThreadReportPlan,
  TaskThreadReportRules,
  TaskThreadTaskInput
} from "../schema/task-thread-report.js";
import { canonicalInputHash, isoNow, type StoreClock } from "./ndjson-store.js";

const DEFAULT_RULES: TaskThreadReportRules = {
  allowNewThreadProposal: true,
  allowNewChannelProposal: false,
  preferredTaskIdPrefix: "AO",
  maxThreadTitleLength: 90
};

interface ScoredChannel {
  category: DiscordInventoryCategory;
  channel: DiscordInventoryChannel;
  score: number;
  reasons: string[];
}

export function planTaskThreadReportDryRun(
  input: TaskThreadReportDryRunInput,
  options: { clock?: StoreClock } = {}
): TaskThreadReportPlan {
  const rules = { ...DEFAULT_RULES, ...input.rules };
  const taskId = normalizeTaskId(input.task, rules);
  const classification = classifyTask(input.task, taskId);
  const orchestration = planOrchestration(classification, input.task);
  const placement = planPlacement(input, taskId, classification, rules);
  const messagePlan = buildMessagePlan(input.task, taskId, classification, placement, orchestration);
  const warnings = buildWarnings(input.task, placement, orchestration);

  return {
    dryRun: true,
    sideEffects: [],
    taskId,
    classification,
    placement,
    orchestration,
    messagePlan,
    auditPreview: [
      {
        type: "agent_os.task_thread_report.dry_run",
        taskId,
        placementDecision: placement.decision,
        strategy: orchestration.strategy,
        timestamp: isoNow(options.clock)
      }
    ],
    warnings
  };
}

function normalizeTaskId(task: TaskThreadTaskInput, rules: TaskThreadReportRules): string {
  if (task.id?.trim()) {
    return task.id.trim();
  }
  const prefix = rules.preferredTaskIdPrefix ?? "AO";
  return `${prefix}-${canonicalInputHash({ title: task.title, source: task.source }).slice(0, 6).toUpperCase()}`;
}

function classifyTask(task: TaskThreadTaskInput, taskId: string): TaskThreadClassification {
  const haystack = `${task.title} ${task.summary ?? ""} ${task.domainHint ?? ""} ${task.typeHint ?? ""}`.toLowerCase();
  const reasons: string[] = [];

  let domain = normalizeHint(task.domainHint);
  if (domain) {
    reasons.push(`domain hint '${task.domainHint}' used`);
  } else if (matches(haystack, ["chromiecraft", "yehonal", "worldserver", "armory", "pvpstats"])) {
    domain = "chromiecraft";
    reasons.push("ChromieCraft/Yehonal keywords matched");
  } else if (matches(haystack, ["example-tenant", "fatture", "invoice", "receipt", "refund"])) {
    domain = "example-tenant";
    reasons.push("example-tenant/backoffice keywords matched");
  } else if (matches(haystack, ["nestdev", "odido", "wipro", "jira"])) {
    domain = "nestdev";
    reasons.push("NestDev/Odido keywords matched");
  } else if (matches(haystack, ["openclaw", "memory", "docs", "documentation", "gateway", "codex", "cas"])) {
    domain = "openclaw";
    reasons.push("OpenClaw platform keywords matched");
  } else if (matches(haystack, ["agent os", "agent-os", "agent mesh", "task thread", "heartbeat", "proactivity"]) || /^(AO|AM)-/i.test(taskId)) {
    domain = "agent_os";
    reasons.push("Agent OS / Agent Mesh task identity matched");
  } else {
    domain = "unknown";
    reasons.push("no confident domain match");
  }

  let taskType = normalizeHint(task.typeHint);
  if (taskType) {
    reasons.push(`type hint '${task.typeHint}' used`);
  } else if (matches(haystack, ["approval", "approve", "decision", "permission", "restart", "reload"])) {
    taskType = "approval";
    reasons.push("approval/decision keywords matched");
  } else if ((task.severity === "critical" || matches(haystack, ["critical", "fatal", "missing access", "incident", "oom", "timeout"])) && domain !== "unknown") {
    taskType = "incident";
    reasons.push("incident/severity keywords matched");
  } else if (matches(haystack, ["docs", "documentation", "index", "indexed", "guide"])) {
    taskType = "docs_indexing";
    reasons.push("documentation/indexing keywords matched");
  } else if (matches(haystack, ["memory", "wiki", "recall"])) {
    taskType = "memory_command_failure";
    reasons.push("memory/wiki keywords matched");
  } else if (matches(haystack, ["heartbeat", "proactivity", "self-improvement", "self improvement", "migliorarsi"])) {
    taskType = "agent_os_self_improvement";
    reasons.push("heartbeat/proactivity keywords matched");
  } else if (matches(haystack, ["implementation", "implement", "build", "code", "reporter", "dry-run", "dry run"])) {
    taskType = domain === "agent_os" ? "agent_os_implementation" : "implementation";
    reasons.push("implementation/build keywords matched");
  } else {
    taskType = domain === "agent_os" ? "agent_os_implementation" : "general_task";
    reasons.push("default task type selected");
  }

  const confidence = domain === "unknown" ? 0.35 : task.domainHint || task.typeHint ? 0.9 : 0.74;
  return { domain, taskType, confidence, reasons };
}

function planOrchestration(
  classification: TaskThreadClassification,
  task: TaskThreadTaskInput
): TaskThreadOrchestrationPlan {
  const text = `${task.title} ${task.summary ?? ""}`.toLowerCase();
  if (classification.domain === "chromiecraft" || matches(text, ["yehonal", "external bot", "discord bot"])) {
    return {
      strategy: "hybrid",
      allowedStrategies: ["discord_bot_to_bot", "hybrid"],
      rationale: ["task may require an external Discord-visible specialist bot"]
    };
  }

  if (classification.domain === "unknown") {
    return {
      strategy: "internal",
      allowedStrategies: ["internal"],
      rationale: ["unknown tasks stay internal until routing is clarified"]
    };
  }

  return {
    strategy: "internal",
    allowedStrategies: ["internal", "hybrid"],
    rationale: ["task can be planned through controllable OpenClaw/runtime surfaces"]
  };
}

function planPlacement(
  input: TaskThreadReportDryRunInput,
  taskId: string,
  classification: TaskThreadClassification,
  rules: TaskThreadReportRules
): TaskThreadPlacementPlan {
  const allChannels = flattenInventory(input.discordInventory.categories);
  const threadMatch = bestThreadMatch(allChannels, input.task, taskId, classification);
  if (threadMatch && threadMatch.score >= 80) {
    return {
      decision: "reuse_existing_thread",
      category: { id: threadMatch.category.id, name: threadMatch.category.name, source: "existing" },
      channel: {
        id: threadMatch.channel.threadMetadata?.parentChannelId ?? threadMatch.channel.id,
        name: threadMatch.channel.name,
        source: "existing"
      },
      thread: { id: threadMatch.channel.id, title: threadMatch.channel.threadMetadata?.title ?? threadMatch.channel.name, source: "existing" },
      rationale: threadMatch.reasons,
      needsApproval: false
    };
  }

  const channelMatch = bestChannelMatch(allChannels, classification, input.task);
  if (channelMatch && channelMatch.score >= 30 && rules.allowNewThreadProposal) {
    return {
      decision: "create_thread_in_existing_channel",
      category: { id: channelMatch.category.id, name: channelMatch.category.name, source: "existing" },
      channel: { id: channelMatch.channel.id, name: channelMatch.channel.name, source: "existing" },
      thread: { title: buildThreadTitle(taskId, input.task.title, rules), source: "proposed" },
      rationale: ["no matching open thread found", ...channelMatch.reasons],
      needsApproval: false
    };
  }

  if (rules.allowNewChannelProposal) {
    return proposeNewChannel(classification, input.task, taskId, rules);
  }

  return {
    decision: "blocked_needs_human_mapping",
    thread: { title: buildThreadTitle(taskId, input.task.title, rules), source: "proposed" },
    rationale: ["no suitable existing Discord channel/thread was found", "new channel proposals are disabled by rule"],
    needsApproval: true,
    approvalReason: "Joseph must identify an existing Discord placement or approve a new one."
  };
}

function flattenInventory(categories: DiscordInventoryCategory[]): ScoredChannel[] {
  return categories.flatMap((category) =>
    category.channels.map((channel) => ({ category, channel, score: 0, reasons: [] }))
  );
}

function bestThreadMatch(
  channels: ScoredChannel[],
  task: TaskThreadTaskInput,
  taskId: string,
  classification: TaskThreadClassification
): ScoredChannel | undefined {
  return best(
    channels
      .filter(({ channel }) => channel.type === "thread" && !channel.archived && channel.threadMetadata?.status !== "archived")
      .map((entry) => scoreThread(entry, task, taskId, classification))
  );
}

function bestChannelMatch(
  channels: ScoredChannel[],
  classification: TaskThreadClassification,
  task: TaskThreadTaskInput
): ScoredChannel | undefined {
  return best(
    channels
      .filter(({ channel }) => channel.type !== "thread" && !channel.archived)
      .map((entry) => scoreChannel(entry, classification, task))
  );
}

function scoreThread(
  entry: ScoredChannel,
  task: TaskThreadTaskInput,
  taskId: string,
  classification: TaskThreadClassification
): ScoredChannel {
  const title = normalizeText(entry.channel.threadMetadata?.title ?? entry.channel.name);
  const taskTitle = normalizeText(task.title);
  const reasons: string[] = [];
  let score = 0;
  if (title.includes(normalizeText(taskId))) {
    score += 85;
    reasons.push("existing thread contains task id");
  }
  if (sharedTokens(title, taskTitle) >= 2) {
    score += 35;
    reasons.push("existing thread title resembles task title");
  }
  if (title.includes(classification.domain.replace("_", " "))) {
    score += 10;
    reasons.push("thread title contains domain");
  }
  return { ...entry, score, reasons };
}

function scoreChannel(
  entry: ScoredChannel,
  classification: TaskThreadClassification,
  task: TaskThreadTaskInput
): ScoredChannel {
  const haystack = normalizeText(`${entry.category.name} ${entry.channel.name} ${entry.channel.topic ?? ""}`);
  const reasons: string[] = [];
  let score = 0;

  for (const keyword of placementKeywords(classification, task)) {
    if (haystack.includes(keyword)) {
      score += 20;
      reasons.push(`matched placement keyword '${keyword}'`);
    }
  }

  if (haystack.includes(classification.domain.replace("_", " "))) {
    score += 30;
    reasons.push("matched domain name");
  }
  if (classification.domain === "agent_os" && matches(haystack, ["agent", "mesh", "openclaw", "os"])) {
    score += 35;
    reasons.push("matched Agent OS/OpenClaw planning surface");
  }
  if (classification.taskType === "approval" && matches(haystack, ["request", "approval", "decision"])) {
    score += 50;
    reasons.push("matched request/approval surface");
  }
  if (classification.taskType === "incident" && matches(haystack, ["incident", "status", "ops", "alert"])) {
    score += 45;
    reasons.push("matched incident/status surface");
  }

  return { ...entry, score, reasons };
}

function placementKeywords(classification: TaskThreadClassification, task: TaskThreadTaskInput): string[] {
  const keywords = [classification.domain.replace("_", " "), classification.taskType.replace(/_/g, " ")];
  if (task.severity === "critical") {
    keywords.push("critical", "incident", "status");
  }
  if (classification.taskType.includes("docs")) {
    keywords.push("docs", "documentation");
  }
  if (classification.taskType.includes("memory")) {
    keywords.push("memory", "wiki");
  }
  return keywords;
}

function proposeNewChannel(
  classification: TaskThreadClassification,
  task: TaskThreadTaskInput,
  taskId: string,
  rules: TaskThreadReportRules
): TaskThreadPlacementPlan {
  const channelName = classification.taskType === "approval" ? "agent-os-requests" : "agent-os-worklog";
  return {
    decision: "propose_new_channel",
    category: { name: "Agent OS", source: "proposed" },
    channel: { name: channelName, source: "proposed" },
    thread: { title: buildThreadTitle(taskId, task.title, rules), source: "proposed" },
    rationale: ["no suitable existing placement found", "new channel proposal allowed by dry-run rules"],
    needsApproval: true,
    approvalReason: "Creating Discord channels/categories requires Joseph approval."
  };
}

function buildThreadTitle(taskId: string, title: string, rules: TaskThreadReportRules): string {
  const cleanTitle = title.replace(/\s+/g, " ").trim();
  const titleWithId = cleanTitle.toLowerCase().startsWith(taskId.toLowerCase())
    ? cleanTitle
    : `${taskId} ${cleanTitle}`;
  const max = rules.maxThreadTitleLength ?? DEFAULT_RULES.maxThreadTitleLength ?? 90;
  return titleWithId.length <= max ? titleWithId : titleWithId.slice(0, max - 1).trimEnd();
}

function buildMessagePlan(
  task: TaskThreadTaskInput,
  taskId: string,
  classification: TaskThreadClassification,
  placement: TaskThreadPlacementPlan,
  orchestration: TaskThreadOrchestrationPlan
): TaskThreadMessagePlanItem[] {
  const base = {
    taskId,
    title: task.title,
    domain: classification.domain,
    taskType: classification.taskType,
    strategy: orchestration.strategy
  };
  const messages: TaskThreadMessagePlanItem[] = [
    message("task_opened", "task_thread", base, `🧭 Task opened: ${taskId} — ${task.title}`),
    message(
      "routing_selected",
      "task_thread",
      base,
      `Routing selected: ${classification.domain}/${classification.taskType}; placement=${placement.decision}.`
    ),
    message(
      "worker_assigned",
      "task_thread",
      base,
      `Orchestration strategy: ${orchestration.strategy}. Allowed: ${orchestration.allowedStrategies.join(", ")}.`
    )
  ];

  if (task.lifecycle?.status === "progress" || task.lifecycle?.nextAction) {
    messages.push(message("progress", "task_thread", base, `Progress/next action: ${task.lifecycle.nextAction ?? "continue work"}.`));
  }
  if (task.lifecycle?.blocker || task.lifecycle?.status === "blocked") {
    messages.push(message("blocker", "task_thread", base, `Blocker: ${task.lifecycle.blocker ?? "blocked; details needed"}.`));
  }
  if (placement.needsApproval || task.lifecycle?.status === "approval_needed") {
    messages.push(
      message(
        "approval_request",
        "request_channel",
        base,
        `Approval needed for ${taskId}: ${placement.approvalReason ?? "human decision required"}`
      )
    );
  }
  if (task.lifecycle?.status === "completed") {
    messages.push(message("completion_claim", "task_thread", base, `Completion claimed for ${taskId}; verification required.`));
  }

  messages.push(
    message("verification_summary", "task_thread", base, `Verification summary placeholder for ${taskId}: evidence required before close.`),
    message("retrospective", "task_thread", base, `Retrospective placeholder for ${taskId}: capture improvements/follow-ups if useful.`)
  );

  return messages;
}

function message(
  lifecycleEvent: TaskThreadMessagePlanItem["lifecycleEvent"],
  target: TaskThreadMessagePlanItem["target"],
  base: Record<string, string>,
  body: string
): TaskThreadMessagePlanItem {
  return {
    lifecycleEvent,
    target,
    send: false,
    body,
    idempotencyKey: `task_thread_report:${canonicalInputHash({ lifecycleEvent, target, ...base, body })}`
  };
}

function buildWarnings(
  task: TaskThreadTaskInput,
  placement: TaskThreadPlacementPlan,
  orchestration: TaskThreadOrchestrationPlan
): string[] {
  const warnings: string[] = [];
  if (placement.decision === "blocked_needs_human_mapping") {
    warnings.push("No suitable existing Discord placement found; human mapping is needed.");
  }
  if (placement.decision === "propose_new_channel") {
    warnings.push("This is only a proposal. Real Discord category/channel creation requires approval.");
  }
  if (task.privacy === "sensitive") {
    warnings.push("Sensitive task: verify Discord placement audience before any live send.");
  }
  if (orchestration.strategy !== "internal") {
    warnings.push("External Discord bot involvement must remain controller-mediated and audited.");
  }
  return warnings;
}

function normalizeHint(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function matches(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle.toLowerCase()));
}

function sharedTokens(a: string, b: string): number {
  const left = new Set(a.split(" ").filter((token) => token.length > 2));
  return b.split(" ").filter((token) => token.length > 2 && left.has(token)).length;
}

function best(entries: ScoredChannel[]): ScoredChannel | undefined {
  return entries.sort((a, b) => b.score - a.score)[0];
}
