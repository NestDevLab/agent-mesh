const DEFAULT_STATE_PATH = "runtime/agent-mesh-wrapper";
const DEFAULT_SIDECAR_PATH = "../openclaw-agent-mesh-gateway";

export function normalizeConfig(raw = {}) {
  const mode = normalizeMode(raw.mode);
  return {
    enabled: raw.enabled !== false,
    mode,
    statePath: stringOr(raw.statePath, DEFAULT_STATE_PATH),
    sidecarPath: stringOr(raw.sidecarPath, DEFAULT_SIDECAR_PATH),
    killSwitch: raw.killSwitch === true,
    paused: raw.paused === true,
    dryRun: raw.dryRun !== false || mode === "observe",
    allowRealCasDispatch: raw.allowRealCasDispatch === true && mode === "enforce",
    allowRealDiscordSend: raw.allowRealDiscordSend === true && mode === "enforce",
    discordAllowlist: normalizeDiscordAllowlist(raw.discordAllowlist),
    casAllowlist: normalizeCasAllowlist(raw.casAllowlist),
    bridge: normalizeBridgeConfig(raw.bridge),
    eventController: normalizeEventControllerConfig(raw.eventController),
    audit: {
      enabled: raw.audit?.enabled !== false,
      path: stringOr(raw.audit?.path, `${DEFAULT_STATE_PATH}/audit.jsonl`)
    }
  };
}

export function planRuntimeAction(config, action) {
  const cfg = normalizeConfig(config);
  const base = {
    accepted: false,
    mode: cfg.mode,
    dryRun: cfg.dryRun,
    reason: "unclassified",
    sideEffectsAllowed: false,
    auditRequired: cfg.audit.enabled
  };

  if (!cfg.enabled) return { ...base, reason: "wrapper_disabled" };
  if (cfg.killSwitch) return { ...base, reason: "kill_switch_active" };
  if (cfg.paused) return { ...base, reason: "wrapper_paused" };

  if (cfg.mode === "observe") {
    return { ...base, accepted: true, reason: "observe_only", sideEffectsAllowed: false };
  }

  if (action?.kind === "cas_dispatch") {
    return planCasAction(cfg, action, base);
  }
  if (action?.kind === "discord_send") {
    return planDiscordAction(cfg, action, base);
  }
  if (action?.kind === "discord_bridge_turn") {
    return planDiscordBridgeTurn(cfg, action, base);
  }
  if (action?.kind === "discord_mention_correction") {
    return planDiscordMentionCorrection(cfg, action, base);
  }
  if (action?.kind === "discord_event_task_turn") {
    return planDiscordEventTaskTurn(cfg, action, base);
  }

  return { ...base, reason: "unknown_action_kind" };
}

export function planDiscordEventTaskTurn(config, action, inheritedBase) {
  const cfg = normalizeConfig(config);
  const base = inheritedBase ?? {
    accepted: false,
    mode: cfg.mode,
    dryRun: cfg.dryRun,
    reason: "unclassified",
    sideEffectsAllowed: false,
    auditRequired: cfg.audit.enabled
  };

  if (!cfg.enabled) return { ...base, reason: "wrapper_disabled" };
  if (cfg.killSwitch) return { ...base, reason: "kill_switch_active" };
  if (cfg.paused) return { ...base, reason: "wrapper_paused" };

  const request = action?.request ?? action ?? {};
  const target = request.target ?? request.source?.target ?? {};
  const source = request.source ?? {};
  const sourceBotId = optionalString(source.botId ?? request.sourceBotId);
  const state = normalizeEventTaskState(action?.state ?? request.state);
  const normalizedTurn = normalizeBridgeTurn(request);
  const latestMessage = normalizedTurn.messages?.at?.(-1) ?? latestNormalizedMessage(request);
  const latestText = latestMessage?.content ?? normalizedTurn.text;
  const advisor = normalizeLlmAdvisorResult(action?.advisor ?? request.advisor);
  const runId = optionalString(request.runId ?? request.orchId ?? extractEventTaskRunId(normalizedTurn.text));

  if (!cfg.eventController.enabled) return { ...base, reason: "event_controller_disabled", nextAction: "none", normalizedTurn };
  if (cfg.mode === "observe") {
    return { ...base, accepted: true, reason: "observe_only", sideEffectsAllowed: false, nextAction: "audit_only", normalizedTurn };
  }
  if (!isDiscordTargetAllowed(cfg.discordAllowlist, target)) {
    return { ...base, reason: "event_task_target_not_allowlisted", nextAction: "pause", normalizedTurn };
  }
  if (sourceBotId && !isBridgeParticipantAllowed(cfg.bridge.participants, sourceBotId)) {
    return { ...base, reason: "event_task_source_not_allowlisted", nextAction: "pause", normalizedTurn };
  }

  const task = resolveEventTask(cfg.eventController.tasks, request.taskId, target, sourceBotId);
  if (!task) return { ...base, reason: "event_task_not_matched", nextAction: "none", normalizedTurn };
  const messageId = optionalString(latestMessage?.id) ?? normalizedTurn.messageIds.at?.(-1);
  if (task.runIdRequired && !runId) {
    return {
      ...base,
      accepted: true,
      reason: "event_task_run_id_required",
      nextAction: "send_confirmation_dry_run",
      sideEffectsAllowed: false,
      taskId: task.id,
      normalizedTurn,
      confirmationMessage: buildRunIdRequiredMessage(task),
      stateTransition: {
        status: state.status,
        messageId,
        itemCount: state.itemCount
      }
    };
  }
  const currentPhaseSourceBotIds = currentEventTaskSourceBotIds(task, state);
  if (sourceBotId && currentPhaseSourceBotIds.length && !currentPhaseSourceBotIds.includes(sourceBotId) && !canReenterCompletedEventTask(task, state, sourceBotId)) {
    return {
      ...base,
      accepted: true,
      reason: "event_task_source_not_enabled_for_current_phase",
      nextAction: "none",
      sideEffectsAllowed: false,
      taskId: task.id,
      normalizedTurn,
      activeSourceBotIds: currentPhaseSourceBotIds
    };
  }

  if (messageId && state.seenMessageIds.includes(messageId)) {
    return { ...base, accepted: true, reason: "event_task_duplicate_message", nextAction: "none", taskId: task.id, runId, normalizedTurn };
  }

  const classification = classifyEventTaskMessage(latestText, task);
  const effectiveState = shouldResetCompletedEventTask(task, state, sourceBotId, classification, runId)
    ? normalizeEventTaskState({ status: "awaiting_status" })
    : state;
  if (effectiveState.status === "done") {
    return { ...base, accepted: true, reason: "event_task_already_done", nextAction: "none", taskId: task.id, runId, normalizedTurn };
  }
  if (classification.kind === "irrelevant") {
    if (advisor && cfg.eventController.llmAdvisor.enabled) {
      return planEventTaskAdvisorClassification(cfg, base, task, advisor, normalizedTurn, messageId, effectiveState, runId);
    }
    return { ...base, accepted: true, reason: "event_task_message_ignored", nextAction: "none", taskId: task.id, runId, normalizedTurn };
  }

  if (effectiveState.itemCount >= task.safetyMaxItems) {
    return {
      ...base,
      accepted: false,
      reason: "event_task_safety_guard_exceeded",
      nextAction: "pause",
      taskId: task.id,
      runId,
      normalizedTurn,
      stateTransition: { status: "paused", reason: "safety_guard_exceeded", runId }
    };
  }

  if (classification.kind === "complete") {
    const missingSources = missingRequiredSourceBotIds(task, effectiveState, sourceBotId, false);
    if (task.requireAllSourcesBeforeComplete && missingSources.length) {
      return {
        ...base,
        accepted: true,
        reason: "event_task_complete_before_required_sources",
        nextAction: "none",
        sideEffectsAllowed: false,
        taskId: task.id,
        runId,
        normalizedTurn,
        completionText: classification.text,
        missingSourceBotIds: missingSources,
        stateTransition: {
          status: effectiveState.status,
          messageId,
          runId,
          itemCount: effectiveState.itemCount
        }
      };
    }
    return {
      ...base,
      accepted: true,
      reason: "event_task_complete_declared",
      nextAction: "stop",
      sideEffectsAllowed: false,
      taskId: task.id,
      runId,
      normalizedTurn,
      completionText: classification.text,
      stateTransition: {
        status: "done",
        messageId,
        runId,
        itemCount: effectiveState.itemCount,
        completedAt: "now"
      }
    };
  }

  const sourceReportCount = sourceBotId ? (effectiveState.sourceReportCounts?.[sourceBotId] ?? 0) : 0;
  if (task.maxReportsPerSource && sourceReportCount >= task.maxReportsPerSource) {
    return {
      ...base,
      accepted: true,
      reason: "event_task_source_report_limit_reached",
      nextAction: "none",
      sideEffectsAllowed: false,
      taskId: task.id,
      runId,
      normalizedTurn,
      item: classification.item,
      status: classification.status,
      warning: classification.warning,
      stateTransition: {
        status: effectiveState.status,
        messageId,
        runId,
        itemCount: effectiveState.itemCount
      }
    };
  }

  const followUp = buildEventTaskFollowUp(task, classification, sourceBotId, effectiveState);
  const autoCompleted = followUp.autoComplete === true;
  return {
    ...base,
    accepted: true,
    reason: autoCompleted ? "event_task_auto_completed" : "event_task_follow_up_required",
    nextAction: "send_follow_up_dry_run",
    sideEffectsAllowed: false,
    taskId: task.id,
    runId,
    normalizedTurn,
    item: classification.item,
    status: classification.status,
    warning: classification.warning,
    followUpMessage: followUp.message,
    stateTransition: {
      status: autoCompleted ? "done" : "awaiting_status",
      messageId,
      runId,
      itemKey: classification.itemKey,
      sourceBotId,
      countSourceReport: true,
      itemCount: effectiveState.itemCount + 1,
      ...(Number.isInteger(followUp.phaseIndex) ? { phaseIndex: followUp.phaseIndex } : {})
    }
  };
}

function planEventTaskAdvisorClassification(cfg, base, task, advisor, normalizedTurn, messageId, state, runId) {
  const threshold = task.llmAdvisor.confidenceThreshold ?? cfg.eventController.llmAdvisor.confidenceThreshold;
  const lowConfidence = advisor.confidence < threshold;
  if (lowConfidence) {
    return {
      ...base,
      accepted: true,
      reason: "event_task_llm_low_confidence_confirmation_required",
      nextAction: "send_confirmation_dry_run",
      sideEffectsAllowed: false,
      taskId: task.id,
      runId,
      normalizedTurn,
      advisor,
      confirmationMessage: buildAdvisorConfirmationMessage(task, advisor),
      stateTransition: {
        status: "awaiting_confirmation",
        messageId,
        runId,
        itemCount: state.itemCount
      }
    };
  }

  if (advisor.classification === "complete") {
    return {
      ...base,
      accepted: true,
      reason: "event_task_llm_complete_advised",
      nextAction: "stop",
      sideEffectsAllowed: false,
      taskId: task.id,
      runId,
      normalizedTurn,
      advisor,
      stateTransition: {
        status: "done",
        messageId,
        runId,
        itemCount: state.itemCount,
        completedAt: "now"
      }
    };
  }

  if (advisor.classification === "handoff") {
    const participant = resolveBridgeParticipant(cfg.bridge.participants, advisor.targetAgentId ?? advisor.targetAgentLabel);
    if (!participant) {
      return {
        ...base,
        accepted: true,
        reason: "event_task_llm_handoff_target_not_allowlisted",
        nextAction: "send_confirmation_dry_run",
        sideEffectsAllowed: false,
        taskId: task.id,
        runId,
        normalizedTurn,
        advisor,
        confirmationMessage: buildAdvisorConfirmationMessage(task, advisor),
        stateTransition: { status: "awaiting_confirmation", messageId, runId, itemCount: state.itemCount }
      };
    }
    const mention = participant.mention ?? (participant.botId ? `<@${participant.botId}>` : advisor.targetAgentLabel);
    return {
      ...base,
      accepted: true,
      reason: "event_task_llm_handoff_advised",
      nextAction: "send_handoff_dry_run",
      sideEffectsAllowed: false,
      taskId: task.id,
      runId,
      normalizedTurn,
      advisor,
      handoffMessage: `${mention} Controller: l'advisor ha classificato questo turno come handoff verso ${participant.label ?? advisor.targetAgentLabel ?? mention}. Confidence ${advisor.confidence.toFixed(2)}.`,
      stateTransition: { status: "awaiting_handoff", messageId, runId, itemCount: state.itemCount }
    };
  }

  if (advisor.classification === "status" && advisor.item) {
    const classification = {
      kind: "status",
      item: advisor.item,
      itemKey: advisor.item.toLowerCase(),
      status: advisor.status,
      warning: advisor.warning
    };
    return {
      ...base,
      accepted: true,
      reason: "event_task_llm_status_advised",
      nextAction: "send_follow_up_dry_run",
      sideEffectsAllowed: false,
      taskId: task.id,
      runId,
      normalizedTurn,
      advisor,
      item: classification.item,
      status: classification.status,
      warning: classification.warning,
      followUpMessage: buildEventTaskFollowUp(task, classification),
      stateTransition: {
        status: "awaiting_status",
        messageId,
        runId,
        itemKey: classification.itemKey,
        itemCount: state.itemCount + 1
      }
    };
  }

  return {
    ...base,
    accepted: true,
    reason: "event_task_llm_advice_unusable",
    nextAction: "send_confirmation_dry_run",
    sideEffectsAllowed: false,
    taskId: task.id,
    runId,
    normalizedTurn,
    advisor,
    confirmationMessage: buildAdvisorConfirmationMessage(task, advisor),
    stateTransition: { status: "awaiting_confirmation", messageId, runId, itemCount: state.itemCount }
  };
}

export function planDiscordMentionCorrection(config, action, inheritedBase) {
  const cfg = normalizeConfig(config);
  const base = inheritedBase ?? {
    accepted: false,
    mode: cfg.mode,
    dryRun: cfg.dryRun,
    reason: "unclassified",
    sideEffectsAllowed: false,
    auditRequired: cfg.audit.enabled
  };

  if (!cfg.enabled) return { ...base, reason: "wrapper_disabled" };
  if (cfg.killSwitch) return { ...base, reason: "kill_switch_active" };
  if (cfg.paused) return { ...base, reason: "wrapper_paused" };

  const request = action?.request ?? action ?? {};
  const target = request.target ?? request.source?.target ?? {};
  const source = request.source ?? {};
  const sourceBotId = optionalString(source.botId ?? request.sourceBotId);
  const normalizedTurn = normalizeBridgeTurn(request);
  const text = normalizedTurn.text;

  if (cfg.mode === "observe") {
    return {
      ...base,
      accepted: true,
      reason: "observe_only",
      sideEffectsAllowed: false,
      nextAction: "audit_only",
      normalizedTurn
    };
  }

  if (!isDiscordTargetAllowed(cfg.discordAllowlist, target)) {
    return { ...base, reason: "mention_correction_target_not_allowlisted", nextAction: "pause", normalizedTurn };
  }
  if (sourceBotId && !isBridgeParticipantAllowed(cfg.bridge.participants, sourceBotId)) {
    return { ...base, reason: "mention_correction_source_not_allowlisted", nextAction: "pause", normalizedTurn };
  }

  if (isStructuredEventTaskMessage(cfg.eventController.tasks, text)) {
    return {
      ...base,
      accepted: true,
      reason: "mention_correction_skipped_event_task_message",
      nextAction: "none",
      sideEffectsAllowed: false,
      normalizedTurn
    };
  }

  const eventTask = cfg.eventController.enabled
    ? resolveEventTask(cfg.eventController.tasks, request.taskId, target, sourceBotId)
    : undefined;
  if (eventTask && !normalizedTurn.footer?.state) {
    return {
      ...base,
      accepted: true,
      reason: "mention_correction_skipped_event_task_channel",
      nextAction: "none",
      sideEffectsAllowed: false,
      taskId: eventTask.id,
      normalizedTurn
    };
  }

  const references = findUntaggedParticipantReferences(cfg.bridge.participants, text, sourceBotId);
  if (!references.length) {
    return {
      ...base,
      accepted: true,
      reason: "mention_correction_not_needed",
      nextAction: "none",
      sideEffectsAllowed: false,
      normalizedTurn
    };
  }

  const sourceParticipant = sourceBotId ? resolveBridgeParticipant(cfg.bridge.participants, sourceBotId) : undefined;
  const correctionMessage = buildMentionCorrectionMessage(references, sourceParticipant);

  return {
    ...base,
    accepted: true,
    reason: "mention_correction_required",
    nextAction: "send_correction_dry_run",
    sideEffectsAllowed: false,
    references,
    correctionMessage,
    normalizedTurn
  };
}

export function buildAgentAddressBook(participants = []) {
  return normalizeBridgeParticipants(participants).map((participant) => ({
    botId: participant.botId,
    mention: participant.mention ?? (participant.botId ? `<@${participant.botId}>` : undefined),
    label: participant.label,
    aliases: participant.aliases
  }));
}

export function formatAgentAddressBook(participants = []) {
  const entries = buildAgentAddressBook(participants);
  if (!entries.length) return "Agent address book: (empty)";
  return [
    "Agent address book:",
    ...entries.map((entry) => {
      const aliases = entry.aliases.length ? ` aliases: ${entry.aliases.join(", ")}` : "";
      return `- ${entry.label ?? entry.botId ?? entry.mention}: ${entry.mention}${aliases}`;
    })
  ].join("\n");
}

export function planDiscordBridgeTurn(config, action, inheritedBase) {
  const cfg = normalizeConfig(config);
  const base = inheritedBase ?? {
    accepted: false,
    mode: cfg.mode,
    dryRun: cfg.dryRun,
    reason: "unclassified",
    sideEffectsAllowed: false,
    auditRequired: cfg.audit.enabled
  };

  if (!cfg.enabled) return { ...base, reason: "wrapper_disabled" };
  if (cfg.killSwitch) return { ...base, reason: "kill_switch_active" };
  if (cfg.paused) return { ...base, reason: "wrapper_paused" };

  const request = action?.request ?? action ?? {};
  const target = request.target ?? request.source?.target ?? {};
  const source = request.source ?? {};
  const normalizedTurn = normalizeBridgeTurn(request);
  const footer = request.footer ?? normalizedTurn.footer;
  const orchId = optionalString(request.orchId ?? footer.orch);
  const expectedSpeakerId = optionalString(request.expectedSpeakerId ?? request.expectedSpeaker?.botId);
  const sourceBotId = optionalString(source.botId ?? request.sourceBotId);

  if (cfg.mode === "observe") {
    return {
      ...base,
      accepted: true,
      reason: "observe_only",
      sideEffectsAllowed: false,
      nextAction: "audit_only",
      footer,
      normalizedTurn
    };
  }

  if (!orchId) return { ...base, reason: "bridge_missing_orch_id", nextAction: "pause" };
  if (!isDiscordTargetAllowed(cfg.discordAllowlist, target)) {
    return { ...base, reason: "bridge_target_not_allowlisted", nextAction: "pause" };
  }
  if (sourceBotId && !isBridgeParticipantAllowed(cfg.bridge.participants, sourceBotId)) {
    return { ...base, reason: "bridge_source_not_allowlisted", nextAction: "pause" };
  }
  if (expectedSpeakerId && sourceBotId && expectedSpeakerId !== sourceBotId) {
    return { ...base, reason: "bridge_unexpected_speaker", nextAction: "pause" };
  }
  if (!footer.state) return { ...base, reason: "bridge_missing_footer_state", nextAction: "pause" };
  if (!["handoff", "done", "paused"].includes(footer.state)) {
    return { ...base, reason: "bridge_unknown_footer_state", nextAction: "pause" };
  }
  if (footer.orch && footer.orch !== orchId) {
    return { ...base, reason: "bridge_orch_mismatch", nextAction: "pause" };
  }

  if (footer.state === "done") {
    if (footer.next) return { ...base, reason: "bridge_done_must_not_tag_next", nextAction: "pause" };
    return { ...base, accepted: true, reason: "bridge_terminal_done", nextAction: "stop", sideEffectsAllowed: false, footer, normalizedTurn };
  }

  if (footer.state === "paused") {
    if (footer.next) return { ...base, reason: "bridge_paused_must_not_tag_next", nextAction: "pause" };
    return { ...base, accepted: true, reason: "bridge_terminal_paused", nextAction: "pause", sideEffectsAllowed: false, footer, normalizedTurn };
  }

  const nextTurn = Number(footer.turn);
  if (!Number.isInteger(nextTurn) || nextTurn < 1) {
    return { ...base, reason: "bridge_invalid_next_turn", nextAction: "pause" };
  }
  if (nextTurn > cfg.bridge.maxTurns) {
    return { ...base, reason: "bridge_max_turns_exceeded", nextAction: "pause" };
  }
  if (!footer.next) return { ...base, reason: "bridge_handoff_missing_next", nextAction: "pause" };
  const nextParticipant = resolveBridgeParticipant(cfg.bridge.participants, footer.next);
  if (!nextParticipant) {
    return { ...base, reason: "bridge_next_not_allowlisted", nextAction: "pause" };
  }
  const normalizedNext = nextParticipant.mention ?? (nextParticipant.botId ? `<@${nextParticipant.botId}>` : footer.next);
  const normalizedFooter = { ...footer, next: normalizedNext };
  if (nextParticipant.botId) normalizedFooter.nextBotId = nextParticipant.botId;

  return {
    ...base,
    accepted: true,
    reason: "bridge_handoff_dry_run_only",
    nextAction: "forward_prompt_dry_run",
    nextSpeakerId: normalizedNext,
    nextTurn,
    sideEffectsAllowed: false,
    footer: normalizedFooter,
    normalizedTurn
  };
}

export function isDiscordTargetAllowed(allowlist, target = {}) {
  const normalized = normalizeDiscordAllowlist(allowlist);
  if (normalized.length === 0) return true;
  return normalized.some((allowed) => {
    return (!allowed.guildId || matchesOptionalId(allowed.guildId, target.guildId))
      && discordChannelMatches(allowed, target)
      && (!allowed.threadId || matchesOptionalId(allowed.threadId, target.threadId));
  });
}

export function isCasWorkspaceAllowed(allowlist, workspaceDir = "", repoScope = "") {
  const normalized = normalizeCasAllowlist(allowlist);
  return normalized.some((allowed) => {
    if (allowed.tempOnly && !workspaceDir.startsWith("/tmp/")) return false;
    if (allowed.workspacePrefix && !workspaceDir.startsWith(allowed.workspacePrefix)) return false;
    if (allowed.repoScope && allowed.repoScope !== repoScope) return false;
    return true;
  });
}

function planCasAction(cfg, action, base) {
  const workspaceDir = action?.workspaceDir
    ?? action?.workspace
    ?? action?.request?.workspaceDir
    ?? action?.request?.workspace
    ?? "";
  const repoScope = action?.repoScope
    ?? action?.request?.repoScope
    ?? "";

  if (!isCasWorkspaceAllowed(cfg.casAllowlist, workspaceDir, repoScope)) {
    return { ...base, reason: "cas_workspace_not_allowlisted" };
  }
  if (!cfg.allowRealCasDispatch) {
    return { ...base, accepted: true, reason: "cas_dry_run_only", sideEffectsAllowed: false };
  }
  return { ...base, accepted: true, dryRun: false, reason: "cas_allow_once_required", sideEffectsAllowed: false };
}

function planDiscordAction(cfg, action, base) {
  const target = action?.target ?? action?.request?.target ?? {};
  if (!isDiscordTargetAllowed(cfg.discordAllowlist, target)) {
    return { ...base, reason: "discord_target_not_allowlisted" };
  }
  if (!cfg.allowRealDiscordSend) {
    return { ...base, accepted: true, reason: "discord_dry_run_only", sideEffectsAllowed: false };
  }
  return { ...base, accepted: true, dryRun: false, reason: "discord_allow_once_required", sideEffectsAllowed: false };
}

function normalizeMode(value) {
  return ["observe", "plan", "enforce"].includes(value) ? value : "observe";
}

function normalizeDiscordAllowlist(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => ({
      guildId: optionalString(entry?.guildId),
      channelId: optionalString(entry?.channelId),
      threadId: optionalString(entry?.threadId),
      categoryId: optionalString(entry?.categoryId)
    }))
    .filter((entry) => entry.channelId || entry.categoryId);
}

function discordChannelMatches(allowed, target = {}) {
  if (allowed.categoryId) {
    return matchesOptionalId(allowed.categoryId, target.categoryId)
      || matchesOptionalId(allowed.categoryId, target.parentCategoryId)
      || matchesOptionalId(allowed.categoryId, target.parentId);
  }
  if (!allowed.channelId) return false;
  return matchesOptionalId(allowed.channelId, target.channelId)
    || matchesOptionalId(allowed.channelId, target.parentChannelId)
    || matchesOptionalId(allowed.channelId, target.parentId);
}

function normalizeCasAllowlist(value) {
  if (!Array.isArray(value)) return [{ tempOnly: true, workspacePrefix: "/tmp/" }];
  return value.map((entry) => ({
    tempOnly: entry?.tempOnly !== false,
    workspacePrefix: optionalString(entry?.workspacePrefix),
    repoScope: optionalString(entry?.repoScope)
  }));
}

function normalizeBridgeConfig(raw = {}) {
  return {
    maxTurns: positiveInteger(raw.maxTurns, 6),
    participants: normalizeBridgeParticipants(raw.participants)
  };
}

function normalizeEventControllerConfig(raw = {}) {
  return {
    enabled: raw?.enabled === true,
    tasks: normalizeEventTasks(raw?.tasks),
    llmAdvisor: normalizeLlmAdvisorConfig(raw?.llmAdvisor),
    safetyMaxItems: positiveInteger(raw?.safetyMaxItems, 100)
  };
}

function normalizeEventTasks(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => ({
      id: stringOr(entry?.id, "default"),
      sourceBotId: optionalString(entry?.sourceBotId),
      sourceBotIds: normalizeSourceBotIds(entry?.sourceBotIds, entry?.sourceBotId),
      target: normalizeDiscordAllowlist([entry?.target ?? {}])[0],
      controllerMention: optionalString(entry?.controllerMention),
      sourceMention: optionalString(entry?.sourceMention ?? (entry?.sourceBotId ? `<@${entry.sourceBotId}>` : undefined)),
      itemLabel: stringOr(entry?.itemLabel, "container"),
      itemPrefixes: normalizeItemPrefixes(entry?.itemPrefixes, entry?.itemLabel),
      taskContext: optionalString(entry?.taskContext),
      stopConditions: normalizeStopConditions(entry?.stopConditions ?? entry?.completionPhrases),
      requiredSourceBotIds: normalizeSourceBotIds(entry?.requiredSourceBotIds, undefined),
      phaseSourceBotIds: normalizePhaseSourceBotIds(entry?.phaseSourceBotIds),
      runIdRequired: entry?.runIdRequired === true,
      matchHints: normalizeStringList(entry?.matchHints),
      requireAllSourcesBeforeComplete: entry?.requireAllSourcesBeforeComplete === true,
      maxReportsPerSource: optionalPositiveInteger(entry?.maxReportsPerSource),
      llmAdvisor: normalizeLlmAdvisorConfig(entry?.llmAdvisor),
      safetyMaxItems: positiveInteger(entry?.safetyMaxItems, positiveInteger(entry?.maxItems, 100))
    }))
    .filter((entry) => entry.id && entry.target?.channelId && entry.sourceBotIds.length);
}

function normalizeSourceBotIds(value, sourceBotId) {
  const raw = Array.isArray(value) ? value : [];
  return [...new Set([sourceBotId, ...raw].map((entry) => optionalString(entry)).filter(Boolean))];
}

function normalizePhaseSourceBotIds(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((group) => normalizeSourceBotIds(group, undefined))
    .filter((group) => group.length > 0);
}

function normalizeLlmAdvisorConfig(raw = {}) {
  return {
    enabled: raw?.enabled === true,
    provider: stringOr(raw?.provider, "openai"),
    model: stringOr(raw?.model, "gpt-5.5"),
    reasoning: stringOr(raw?.reasoning, "off"),
    confidenceThreshold: boundedNumber(raw?.confidenceThreshold, 0.7, 0, 1),
    maxInputChars: positiveInteger(raw?.maxInputChars, 4000)
  };
}

function normalizeLlmAdvisorResult(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const classification = normalizeAdvisorClassification(raw.classification ?? raw.intent ?? raw.type);
  if (!["status", "complete", "handoff", "irrelevant", "ambiguous"].includes(classification)) return undefined;
  return {
    classification,
    confidence: boundedNumber(raw.confidence, 0, 0, 1),
    item: optionalString(raw.item ?? raw.extracted?.item),
    status: optionalString(raw.status ?? raw.extracted?.status),
    warning: optionalString(raw.warning ?? raw.extracted?.warning),
    targetAgentId: optionalString(raw.targetAgentId ?? raw.extracted?.targetAgentId),
    targetAgentLabel: optionalString(raw.targetAgentLabel ?? raw.extracted?.targetAgentLabel),
    rationale: optionalString(raw.rationale)
  };
}

function normalizeAdvisorClassification(value) {
  const normalized = optionalString(value)?.toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized) return undefined;
  const allowed = ["status", "complete", "handoff", "irrelevant", "ambiguous"];
  const aliases = {
    status_update: "status",
    container_status: "status",
    item_status: "status",
    progress: "status",
    done: "complete",
    finished: "complete",
    completion: "complete",
    completed: "complete",
    close: "complete",
    pass: "handoff",
    pass_the_ball: "handoff",
    next_agent: "handoff",
    transfer: "handoff",
    ignore: "irrelevant",
    unrelated: "irrelevant",
    unsure: "ambiguous",
    unclear: "ambiguous"
  };
  return aliases[normalized] ?? (allowed.includes(normalized) ? normalized : "ambiguous");
}

function normalizeStopConditions(value) {
  const raw = Array.isArray(value) ? value : [];
  return raw
    .map((entry) => {
      if (typeof entry === "string") return { type: "phrase", value: entry.trim() };
      return {
        type: ["phrase", "regex"].includes(entry?.type) ? entry.type : "phrase",
        value: optionalString(entry?.value ?? entry?.phrase ?? entry?.regex)
      };
    })
    .filter((entry) => entry.value);
}

function normalizeItemPrefixes(value, itemLabel) {
  const fallback = stringOr(itemLabel, "item");
  const raw = Array.isArray(value) ? value : [fallback];
  return [...new Set(raw.map((entry) => optionalString(entry)).filter(Boolean))];
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => optionalString(entry)).filter(Boolean))];
}

function normalizeEventTaskState(raw = {}) {
  return {
    status: ["idle", "awaiting_status", "awaiting_confirmation", "awaiting_handoff", "done", "paused"].includes(raw?.status) ? raw.status : "awaiting_status",
    seenMessageIds: Array.isArray(raw?.seenMessageIds) ? raw.seenMessageIds.map((entry) => optionalString(entry)).filter(Boolean) : [],
    seenItems: Array.isArray(raw?.seenItems) ? raw.seenItems.map((entry) => optionalString(entry)).filter(Boolean).slice(-100) : [],
    seenSourceBotIds: Array.isArray(raw?.seenSourceBotIds) ? raw.seenSourceBotIds.map((entry) => optionalString(entry)).filter(Boolean) : [],
    sourceReportCounts: normalizeSourceReportCounts(raw?.sourceReportCounts),
    itemCount: Number.isInteger(raw?.itemCount) && raw.itemCount >= 0 ? raw.itemCount : 0,
    phaseIndex: Number.isInteger(raw?.phaseIndex) && raw.phaseIndex >= 0 ? raw.phaseIndex : 0,
    runId: optionalString(raw?.runId)
  };
}

function normalizeSourceReportCounts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .map(([key, count]) => [optionalString(key), Number.isInteger(count) && count > 0 ? count : 0])
    .filter(([key, count]) => key && count > 0));
}

function resolveEventTask(tasks, taskId, target, sourceBotId) {
  const requestedId = optionalString(taskId);
  return tasks.find((task) => {
    if (requestedId && task.id !== requestedId) return false;
    if (sourceBotId && !task.sourceBotIds.includes(sourceBotId)) return false;
    return isDiscordTargetAllowed([task.target], target);
  });
}

function classifyEventTaskMessage(text, task) {
  const content = String(text ?? "").trim();
  if (!content) return { kind: "irrelevant" };
  if (task.stopConditions.some((condition) => matchesStopCondition(content, condition))) {
    return { kind: "complete", text: content };
  }
  const item = extractEventTaskItem(content, task);
  if (!item) return { kind: "irrelevant" };
  const status = content.match(/^\s*Status\s*:\s*(.+?)\s*$/im)?.[1]?.trim();
  const warning = content.match(/^\s*Warning\s*:\s*(.+?)\s*$/im)?.[1]?.trim();
  return {
    kind: "status",
    item,
    itemKey: item.toLowerCase(),
    status,
    warning
  };
}

function extractEventTaskItem(content, task) {
  for (const prefix of task.itemPrefixes ?? [task.itemLabel ?? "item"]) {
    const match = content.match(new RegExp(`^\\s*${escapeRegExp(prefix)}\\s*:\\s*(.+?)\\s*$`, "im"));
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return undefined;
}

function matchesStopCondition(content, condition) {
  if (condition.type === "regex") {
    try {
      return new RegExp(condition.value, "iu").test(content);
    } catch {
      return false;
    }
  }
  return content.toLowerCase().includes(condition.value.toLowerCase());
}

function buildEventTaskFollowUp(task, classification, sourceBotId, state = {}) {
  const hasRequiredSources = (task.requiredSourceBotIds?.length ?? 0) > 0;
  const currentPhase = currentEventTaskSourceBotIds(task, state);
  const phaseMode = currentPhase.length > 0;
  const sourceMention = hasRequiredSources
    ? ""
    : (task.sourceMention ?? (sourceBotId ? `<@${sourceBotId}>` : (task.sourceBotId ? `<@${task.sourceBotId}>` : "")));
  const status = classification.status ? `: ${classification.status}` : "";
  const warning = classification.warning ? ` Warning noted: ${classification.warning}` : "";
  const stopPhrase = task.stopConditions.find((condition) => condition.type === "phrase")?.value ?? "Inventory complete";
  const seenWithCurrent = sourceBotId ? [...new Set([...(state.seenSourceBotIds ?? []), sourceBotId])] : (state.seenSourceBotIds ?? []);
  const missingSources = phaseMode
    ? currentPhase.filter((botId) => !seenWithCurrent.includes(botId))
    : missingRequiredSourceBotIds(task, state, sourceBotId, true);
  const phaseAdvance = phaseMode && missingSources.length === 0
    ? nextEventTaskPhase(task, state)
    : undefined;
  const autoComplete = phaseMode
    ? missingSources.length === 0 && !phaseAdvance && shouldAutoCompleteEventTask(task, state, sourceBotId)
    : hasRequiredSources && missingSources.length === 0 && shouldAutoCompleteEventTask(task, state, sourceBotId);
  const nextInstruction = phaseMode
    ? buildPhaseFollowUpInstruction(task, stopPhrase, missingSources, phaseAdvance, autoComplete)
    : hasRequiredSources && missingSources.length
      ? `Follow-up: mancano ancora report da ${missingSources.map((id) => `<@${id}>`).join(", ")}. Chi non ha ancora risposto invii un solo ${task.itemLabel}; se il giro è completo, dichiarate “${stopPhrase}”.`
      : hasRequiredSources
        ? autoComplete
          ? `Follow-up: tutti i report richiesti risultano presenti. Task marcato automaticamente come completato.`
          : `Follow-up: tutti i report richiesti risultano presenti. Se hai finito la lista, dichiaralo tu con “${stopPhrase}”.`
        : `Follow-up: continua con il prossimo ${task.itemLabel} non ancora riportato. Un solo ${task.itemLabel} per messaggio; se hai finito la lista, dichiaralo tu con “${stopPhrase}”.`;
  const ack = [sourceMention, `Ricevuto ${classification.item}${status}.${warning}`]
    .filter(Boolean)
    .join(" ")
    .trim();
  return {
    message: [ack, "", nextInstruction].join("\n"),
    phaseIndex: phaseAdvance?.phaseIndex,
    autoComplete
  };
}

function buildPhaseFollowUpInstruction(task, stopPhrase, missingSources, phaseAdvance, autoComplete = false) {
  if (missingSources.length) {
    return `Follow-up: in questa fase possono ancora rispondere solo ${missingSources.map((id) => `<@${id}>`).join(", ")}. Un solo ${task.itemLabel} per messaggio.`;
  }
  if (phaseAdvance?.mentions?.length) {
    return `Follow-up: fase completata. Ora possono intervenire solo ${phaseAdvance.mentions.map((id) => `<@${id}>`).join(", ")}. Un solo ${task.itemLabel} per messaggio; quando la fase è completa, proseguiremo.`;
  }
  if (autoComplete) {
    return "Follow-up: tutte le fasi richieste risultano complete. Task marcato automaticamente come completato.";
  }
  return `Follow-up: tutte le fasi richieste risultano complete. Se hai finito la lista, dichiaralo tu con “${stopPhrase}”.`;
}

function shouldAutoCompleteEventTask(task, state = {}, currentSourceBotId) {
  if (task.requireAllSourcesBeforeComplete !== true) return false;
  return missingRequiredSourceBotIds(task, state, currentSourceBotId, true).length === 0;
}

function currentEventTaskSourceBotIds(task, state = {}) {
  if (!task.phaseSourceBotIds?.length) return [];
  const phaseIndex = Number.isInteger(state.phaseIndex) ? state.phaseIndex : 0;
  return task.phaseSourceBotIds[phaseIndex] ?? [];
}

function nextEventTaskPhase(task, state = {}) {
  if (!task.phaseSourceBotIds?.length) return undefined;
  const phaseIndex = Number.isInteger(state.phaseIndex) ? state.phaseIndex : 0;
  const nextIndex = phaseIndex + 1;
  const nextGroup = task.phaseSourceBotIds[nextIndex];
  if (!nextGroup?.length) return undefined;
  return { phaseIndex: nextIndex, mentions: nextGroup };
}

function canReenterCompletedEventTask(task, state = {}, sourceBotId) {
  if (state.status !== "done") return false;
  const firstPhase = task.phaseSourceBotIds?.[0] ?? [];
  if (!firstPhase.length) return false;
  return Boolean(sourceBotId && firstPhase.includes(sourceBotId));
}

function shouldResetCompletedEventTask(task, state = {}, sourceBotId, classification, runId) {
  if (classification?.kind !== "status") return false;
  if (state.runId && runId && state.runId === runId) return false;
  if (state.runId && !runId) return false;
  return canReenterCompletedEventTask(task, state, sourceBotId);
}

function missingRequiredSourceBotIds(task, state = {}, currentSourceBotId, countCurrentSource) {
  const required = task.requiredSourceBotIds?.length ? task.requiredSourceBotIds : [];
  if (!required.length) return [];
  const seen = new Set(state.seenSourceBotIds ?? []);
  if (countCurrentSource && currentSourceBotId) seen.add(currentSourceBotId);
  return required.filter((botId) => !seen.has(botId));
}

function isStructuredEventTaskMessage(tasks, text) {
  const content = String(text ?? "");
  if (!content.trim()) return false;
  return tasks.some((task) => task.itemPrefixes?.some((prefix) => (
    new RegExp(`^\\s*${escapeRegExp(prefix)}\\s*:`, "im").test(content)
  )));
}

function buildAdvisorConfirmationMessage(task, advisor) {
  const sourceMention = task.sourceMention ?? (task.sourceBotId ? `<@${task.sourceBotId}>` : "");
  const label = advisor.classification === "complete"
    ? "vuoi davvero chiudere il task?"
    : advisor.classification === "handoff"
      ? `vuoi davvero passare la palla a ${advisor.targetAgentLabel ?? advisor.targetAgentId ?? "un altro agente"}?`
      : advisor.classification === "status"
        ? `confermi che questo è uno status di ${task.itemLabel}${advisor.item ? ` per ${advisor.item}` : ""}?`
        : "non ho classificato con confidenza sufficiente: confermi il prossimo passo?";
  return [
    `${sourceMention} Controller: classificazione ambigua (${advisor.classification}, confidence ${advisor.confidence.toFixed(2)}). ${label}`.trim(),
    "Rispondi in modo naturale; agirò solo dopo conferma chiara o nuova evidenza."
  ].join("\n");
}

function buildRunIdRequiredMessage(task) {
  const sourceMention = task.sourceMention ?? (task.sourceBotId ? `<@${task.sourceBotId}>` : "");
  return [
    `${sourceMention} Controller: questo task richiede un RunId esplicito per evitare di riusare stato di un test precedente.`.trim(),
    "Invia di nuovo il report includendo una riga `RunId: <id-univoco>` oppure `OrchId: <id-univoco>`."
  ].join("\n");
}

function normalizeBridgeParticipants(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const label = optionalString(entry?.label);
      const aliases = normalizeAliases(entry?.aliases, label);
      return {
        botId: optionalString(entry?.botId ?? entry?.id),
        mention: optionalString(entry?.mention),
        label,
        aliases,
        delivery: optionalString(entry?.delivery),
        agentId: optionalString(entry?.agentId),
        discordAccountId: optionalString(entry?.discordAccountId),
        externalGateway: optionalString(entry?.externalGateway),
        externalAgentId: optionalString(entry?.externalAgentId),
        role: optionalString(entry?.role),
        reason: optionalString(entry?.reason)
      };
    })
    .filter((entry) => entry.botId || entry.mention);
}

function normalizeAliases(value, label) {
  const rawAliases = Array.isArray(value) ? value : [];
  return [...new Set([label, ...rawAliases]
    .map((entry) => optionalString(entry))
    .filter(Boolean))];
}

function isBridgeParticipantAllowed(participants, idOrMention) {
  return Boolean(resolveBridgeParticipant(participants, idOrMention));
}

function resolveBridgeParticipant(participants, idOrMentionOrLabel) {
  const normalized = optionalString(idOrMentionOrLabel);
  if (!normalized) return undefined;
  const bareId = normalized.match(/^<@!?(\d+)>$/)?.[1] ?? normalized;
  const label = normalized.replace(/^@/, "");
  const lowerLabel = label.toLowerCase();
  return participants.find((entry) => (
    entry.botId === bareId
    || entry.mention === normalized
    || entry.mention === `<@${bareId}>`
    || (entry.label && entry.label.toLowerCase() === lowerLabel)
    || (entry.label && `@${entry.label}`.toLowerCase() === normalized.toLowerCase())
    || entry.aliases?.some((alias) => alias.toLowerCase() === lowerLabel || `@${alias}`.toLowerCase() === normalized.toLowerCase())
  ));
}

function findUntaggedParticipantReferences(participants, text, sourceBotId) {
  const content = String(text ?? "");
  if (!content.trim()) return [];
  return normalizeBridgeParticipants(participants)
    .filter((participant) => participant.botId !== sourceBotId)
    .filter((participant) => participant.mention || participant.botId)
    .filter((participant) => !hasRealMentionForParticipant(content, participant))
    .map((participant) => {
      const matchedAlias = participant.aliases.find((alias) => containsAgentNameReference(content, alias));
      if (!matchedAlias) return undefined;
      const mention = participant.mention ?? `<@${participant.botId}>`;
      return {
        botId: participant.botId,
        mention,
        label: participant.label,
        matchedAlias
      };
    })
    .filter(Boolean);
}

function hasRealMentionForParticipant(text, participant) {
  if (participant.mention && text.includes(participant.mention)) return true;
  if (participant.botId && new RegExp(`<@!?${escapeRegExp(participant.botId)}>`).test(text)) return true;
  return false;
}

function containsAgentNameReference(text, alias) {
  const escaped = escapeRegExp(alias).replace(/\s+/g, "\\s+");
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])@?${escaped}([^\\p{L}\\p{N}_]|$)`, "iu");
  return pattern.test(text);
}

function buildMentionCorrectionMessage(references, sourceParticipant) {
  const mentions = references.map((reference) => reference.mention).join(" ");
  const labels = references.map((reference) => reference.label ?? reference.matchedAlias ?? reference.botId).join(", ");
  const sourceLabel = sourceParticipant?.label ?? "Il bot precedente";
  return `${mentions} Controller: ${sourceLabel} ha nominato ${labels} senza tag Discord valido. Applico io il tag corretto per continuare il turno.`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseOrchestrationFooter(text = "") {
  const footer = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\s*(ORCH|TURN|NEXT|STATE|REASON)\s*:\s*(.*?)\s*$/i);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2];
    if (key === "orch") footer.orch = value;
    if (key === "turn") footer.turn = value;
    if (key === "next") footer.next = value;
    if (key === "state") footer.state = value.toLowerCase();
    if (key === "reason") footer.pauseReason = value;
  }
  if (footer.next) {
    const mentionId = footer.next.match(/^<@!?(\d+)>$/)?.[1];
    if (mentionId) footer.nextBotId = mentionId;
  }
  return footer;
}

export function extractEventTaskRunId(text = "") {
  const match = String(text ?? "").match(/^\s*(?:RunId|Run ID|OrchId|Orch ID|Run)\s*:\s*([^\n`]+?)\s*$/im);
  return optionalString(match?.[1]);
}

export function normalizeBridgeTurn(request = {}) {
  const messages = normalizeBridgeMessages(request.messages ?? request.messageBatch);
  const text = messages.length
    ? messages.map((message) => message.content).filter(Boolean).join("\n")
    : String(request.messageText ?? request.text ?? "");
  const footer = parseOrchestrationFooter(text);
  const footerMessages = messages.filter((message) => parseOrchestrationFooter(message.content).state);
  const bodyMessages = messages.filter((message) => !parseOrchestrationFooter(message.content).state);
  return {
    splitMessages: messages.length > 1 && footerMessages.length > 0 && bodyMessages.length > 0,
    messages,
    messageIds: messages.map((message) => message.id).filter(Boolean),
    bodyMessageIds: bodyMessages.map((message) => message.id).filter(Boolean),
    footerMessageIds: footerMessages.map((message) => message.id).filter(Boolean),
    text,
    footer
  };
}

function latestNormalizedMessage(request = {}) {
  const messages = normalizeBridgeMessages(request.messages ?? request.messageBatch);
  return messages.at(-1);
}

function normalizeBridgeMessages(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index) => ({
      id: optionalString(entry?.id ?? entry?.messageId),
      content: typeof (entry?.content ?? entry?.text) === "string" ? (entry.content ?? entry.text) : "",
      authorId: optionalString(entry?.authorId ?? entry?.author?.id),
      timestamp: optionalString(entry?.timestamp ?? entry?.timestampUtc),
      index
    }))
    .filter((entry) => entry.content.trim())
    .sort((left, right) => {
      if (left.timestamp && right.timestamp && left.timestamp !== right.timestamp) {
        return left.timestamp.localeCompare(right.timestamp);
      }
      return left.index - right.index;
    });
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function optionalPositiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function boundedNumber(value, fallback, min, max) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sameOptional(left, right) {
  return (left ?? null) === (right ?? null);
}

function matchesOptionalId(allowed, actual) {
  return allowed === "*" || sameOptional(allowed, actual);
}
