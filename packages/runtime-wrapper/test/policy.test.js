import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentAddressBook,
  extractEventTaskRunId,
  formatAgentAddressBook,
  isRunnerWorkspaceAllowed,
  isDiscordTargetAllowed,
  normalizeConfig,
  normalizeBridgeTurn,
  parseOrchestrationFooter,
  planDiscordBridgeTurn,
  planDiscordEventTaskTurn,
  planDiscordMentionCorrection,
  planRuntimeAction
} from "../policy.js";

test("defaults to observe dry-run with temp-only runner", () => {
  const cfg = normalizeConfig({});
  assert.equal(cfg.mode, "observe");
  assert.equal(cfg.dryRun, true);
  assert.equal(cfg.allowRealRunnerDispatch, false);
  assert.equal(cfg.allowRealDiscordSend, false);
  assert.equal(isRunnerWorkspaceAllowed(cfg.runnerAllowlist, "/tmp/openclaw-agent-mesh-demo", "demo"), true);
  assert.equal(isRunnerWorkspaceAllowed(cfg.runnerAllowlist, "/var/repo", "demo"), false);
});

test("observe mode accepts planning but never side effects", () => {
  const plan = planRuntimeAction({}, { kind: "discord_send" });
  assert.equal(plan.accepted, true);
  assert.equal(plan.reason, "observe_only");
  assert.equal(plan.sideEffectsAllowed, false);
});

test("kill-switch and pause block actions", () => {
  assert.equal(planRuntimeAction({ killSwitch: true }, { kind: "runner_dispatch" }).reason, "kill_switch_active");
  assert.equal(planRuntimeAction({ paused: true }, { kind: "runner_dispatch" }).reason, "wrapper_paused");
});

test("Discord target allowlist is exact on channel/thread/guild", () => {
  const allowlist = [{ guildId: "g1", channelId: "c1", threadId: "t1" }];
  assert.equal(isDiscordTargetAllowed(allowlist, { guildId: "g1", channelId: "c1", threadId: "t1" }), true);
  assert.equal(isDiscordTargetAllowed(allowlist, { guildId: "g1", channelId: "c1", threadId: "other" }), false);
});

test("empty Discord target allowlist allows every target", () => {
  assert.equal(isDiscordTargetAllowed([], { guildId: "g1", channelId: "c1", threadId: "t1" }), true);
  assert.equal(isDiscordTargetAllowed(undefined, { guildId: "other", channelId: "other", threadId: "other" }), true);
});

test("Discord wildcard channel can be global without guild binding", () => {
  assert.equal(isDiscordTargetAllowed([{ channelId: "*" }], { guildId: "g1", channelId: "c1" }), true);
  assert.equal(isDiscordTargetAllowed([{ channelId: "*" }], { channelId: "c1", threadId: "t1" }), true);
});

test("Discord target allowlist inherits from parent channel and category", () => {
  assert.equal(
    isDiscordTargetAllowed(
      [{ guildId: "g1", channelId: "parent-channel" }],
      { guildId: "g1", channelId: "thread-1", parentChannelId: "parent-channel", threadId: "thread-1" }
    ),
    true
  );
  assert.equal(
    isDiscordTargetAllowed(
      [{ guildId: "g1", categoryId: "category-1" }],
      { guildId: "g1", channelId: "channel-1", categoryId: "category-1" }
    ),
    true
  );
  assert.equal(
    isDiscordTargetAllowed(
      [{ guildId: "g1", categoryId: "category-1" }],
      { guildId: "g1", channelId: "thread-1", parentChannelId: "channel-1", parentCategoryId: "category-1", threadId: "thread-1" }
    ),
    true
  );
});

test("plan mode allows dry-run runner only for allowlisted temp workspace", () => {
  const cfg = {
    mode: "plan",
    runnerAllowlist: [{ tempOnly: true, workspacePrefix: "/tmp/openclaw-agent-mesh-" }]
  };
  const accepted = planRuntimeAction(cfg, {
    kind: "runner_dispatch",
    workspaceDir: "/tmp/openclaw-agent-mesh-demo",
    repoScope: "demo"
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.reason, "runner_dry_run_only");
  assert.equal(accepted.sideEffectsAllowed, false);

  const denied = planRuntimeAction(cfg, {
    kind: "runner_dispatch",
    workspaceDir: "/tmp/other",
    repoScope: "demo"
  });
  assert.equal(denied.accepted, false);
  assert.equal(denied.reason, "runner_workspace_not_allowlisted");
});

test("plan mode accepts nested request payloads used by runtime smoke", () => {
  const cfg = {
    mode: "plan",
    runnerAllowlist: [{ tempOnly: true, workspacePrefix: "/tmp/openclaw-agent-mesh-" }],
    discordAllowlist: [{ guildId: "g1", channelId: "c1", threadId: "t1" }]
  };

  const runner = planRuntimeAction(cfg, {
    kind: "runner_dispatch",
    request: {
      workspace: "/tmp/openclaw-agent-mesh-demo",
      repoScope: "demo"
    }
  });
  assert.equal(runner.accepted, true);
  assert.equal(runner.reason, "runner_dry_run_only");
  assert.equal(runner.sideEffectsAllowed, false);

  const discord = planRuntimeAction(cfg, {
    kind: "discord_send",
    request: {
      target: { guildId: "g1", channelId: "c1", threadId: "t1" }
    }
  });
  assert.equal(discord.accepted, true);
  assert.equal(discord.reason, "discord_dry_run_only");
  assert.equal(discord.sideEffectsAllowed, false);
});

test("enforce real flags still return allow-once-required, not direct side effects", () => {
  const cfg = {
    mode: "enforce",
    allowRealDiscordSend: true,
    discordAllowlist: [{ guildId: "g1", channelId: "c1", threadId: "t1" }]
  };
  const plan = planRuntimeAction(cfg, {
    kind: "discord_send",
    target: { guildId: "g1", channelId: "c1", threadId: "t1" }
  });
  assert.equal(plan.accepted, true);
  assert.equal(plan.dryRun, false);
  assert.equal(plan.reason, "discord_allow_once_required");
  assert.equal(plan.sideEffectsAllowed, false);
});

test("parses compact orchestration footer", () => {
  const footer = parseOrchestrationFooter(`Looks good.\n---\nORCH: demo-1\nTURN: 2\nNEXT: <@222>\nSTATE: handoff\nMi fermo qui`);
  assert.deepEqual(footer, {
    orch: "demo-1",
    turn: "2",
    next: "<@222>",
    nextBotId: "222",
    state: "handoff"
  });
});

test("bridge planner allows only validated handoff in dry-run", () => {
  const cfg = {
    mode: "plan",
    discordAllowlist: [{ guildId: "g1", channelId: "c1", threadId: "t1" }],
    bridge: {
      maxTurns: 4,
      participants: [{ botId: "111", mention: "<@111>" }, { botId: "222", mention: "<@222>" }]
    }
  };
  const plan = planDiscordBridgeTurn(cfg, {
    request: {
      orchId: "demo-1",
      expectedSpeakerId: "111",
      source: { botId: "111" },
      target: { guildId: "g1", channelId: "c1", threadId: "t1" },
      messageText: "Done with my turn.\n---\nORCH: demo-1\nTURN: 2\nNEXT: <@222>\nSTATE: handoff\nMi fermo qui"
    }
  });
  assert.equal(plan.accepted, true);
  assert.equal(plan.reason, "bridge_handoff_dry_run_only");
  assert.equal(plan.nextAction, "forward_prompt_dry_run");
  assert.equal(plan.nextSpeakerId, "<@222>");
  assert.equal(plan.sideEffectsAllowed, false);
});

test("bridge planner blocks unmanaged bot and invalid terminal tag", () => {
  const cfg = {
    mode: "plan",
    discordAllowlist: [{ guildId: "g1", channelId: "c1", threadId: "t1" }],
    bridge: { participants: [{ botId: "111", mention: "<@111>" }] }
  };
  const unmanaged = planDiscordBridgeTurn(cfg, {
    request: {
      orchId: "demo-1",
      expectedSpeakerId: "333",
      source: { botId: "333" },
      target: { guildId: "g1", channelId: "c1", threadId: "t1" },
      footer: { orch: "demo-1", state: "done" }
    }
  });
  assert.equal(unmanaged.accepted, false);
  assert.equal(unmanaged.reason, "bridge_source_not_allowlisted");

  const taggedDone = planDiscordBridgeTurn(cfg, {
    request: {
      orchId: "demo-1",
      expectedSpeakerId: "111",
      source: { botId: "111" },
      target: { guildId: "g1", channelId: "c1", threadId: "t1" },
      footer: { orch: "demo-1", state: "done", next: "<@111>" }
    }
  });
  assert.equal(taggedDone.accepted, false);
  assert.equal(taggedDone.reason, "bridge_done_must_not_tag_next");
});

test("bridge planner normalizes split body and footer messages", () => {
  const cfg = {
    mode: "plan",
    discordAllowlist: [{ guildId: "g1", channelId: "c1", threadId: "t1" }],
    bridge: { participants: [{ botId: "111", mention: "<@111>" }] }
  };
  const request = {
    orchId: "demo-split",
    expectedSpeakerId: "111",
    source: { botId: "111" },
    target: { guildId: "g1", channelId: "c1", threadId: "t1" },
    messages: [
      {
        id: "body-1",
        content: "Il formato è chiaro; non serve un secondo parere.",
        timestamp: "2026-05-11T14:10:11.990Z"
      },
      {
        id: "footer-1",
        content: "---\nORCH: demo-split\nSTATE: done\nMi fermo qui",
        timestamp: "2026-05-11T14:10:20.118Z"
      }
    ]
  };

  const normalized = normalizeBridgeTurn(request);
  assert.equal(normalized.splitMessages, true);
  assert.deepEqual(normalized.bodyMessageIds, ["body-1"]);
  assert.deepEqual(normalized.footerMessageIds, ["footer-1"]);
  assert.equal(normalized.footer.state, "done");

  const plan = planDiscordBridgeTurn(cfg, { request });
  assert.equal(plan.accepted, true);
  assert.equal(plan.reason, "bridge_terminal_done");
  assert.equal(plan.nextAction, "stop");
  assert.equal(plan.sideEffectsAllowed, false);
  assert.equal(plan.normalizedTurn.splitMessages, true);
});

test("bridge planner resolves allowlisted NEXT display labels to mentions", () => {
  const cfg = {
    mode: "plan",
    discordAllowlist: [{ guildId: "g1", channelId: "c1" }],
    bridge: {
      participants: [
        { botId: "111", mention: "<@111>", label: "Agent Alpha" },
        { botId: "222", mention: "<@222>", label: "Agent Beta" }
      ]
    }
  };
  const plan = planDiscordBridgeTurn(cfg, {
    request: {
      orchId: "demo-label-next",
      expectedSpeakerId: "111",
      source: { botId: "111" },
      target: { guildId: "g1", channelId: "c1" },
      messageText: "Please continue.\n---\nORCH: demo-label-next\nTURN: 2\nNEXT: @Agent Beta\nSTATE: handoff\nMi fermo qui"
    }
  });
  assert.equal(plan.accepted, true);
  assert.equal(plan.reason, "bridge_handoff_dry_run_only");
  assert.equal(plan.nextSpeakerId, "<@222>");
  assert.equal(plan.footer.next, "<@222>");
  assert.equal(plan.footer.nextBotId, "222");
});

test("address book includes labels, mentions, and aliases", () => {
  const entries = buildAgentAddressBook([
    { botId: "111", mention: "<@111>", label: "Agent Alpha", aliases: ["Agent Alpha"] },
    { botId: "222", mention: "<@222>", label: "Agent Beta", aliases: ["Agent Beta"] }
  ]);
  assert.deepEqual(entries, [
    { botId: "111", mention: "<@111>", label: "Agent Alpha", aliases: ["Agent Alpha"] },
    { botId: "222", mention: "<@222>", label: "Agent Beta", aliases: ["Agent Beta"] }
  ]);
  assert.match(formatAgentAddressBook(entries), /Agent Beta: <@222>/);
});

test("mention correction skips bot-authored natural agent names without creating pings", () => {
  const cfg = {
    mode: "plan",
    discordAllowlist: [{ guildId: "g1", channelId: "c1" }],
    bridge: {
      participants: [
        { botId: "111", mention: "<@111>", label: "Agent Alpha", aliases: ["Agent Alpha"] },
        { botId: "222", mention: "<@222>", label: "Agent Beta", aliases: ["Agent Beta"] }
      ]
    }
  };
  const plan = planDiscordMentionCorrection(cfg, {
    request: {
      source: { botId: "111" },
      target: { guildId: "g1", channelId: "c1" },
      messageText: "Secondo me deve continuare Agent Beta con il prossimo controllo."
    }
  });
  assert.equal(plan.accepted, true);
  assert.equal(plan.reason, "mention_correction_skipped_bot_source");
  assert.equal(plan.nextAction, "none");
  assert.equal(plan.references, undefined);
  assert.equal(plan.correctionMessage, undefined);
});

test("mention correction skips bot-authored mentions and self references", () => {
  const cfg = {
    mode: "plan",
    discordAllowlist: [{ guildId: "g1", channelId: "c1" }],
    bridge: {
      participants: [
        { botId: "111", mention: "<@111>", label: "Agent Alpha" },
        { botId: "222", mention: "<@222>", label: "Agent Beta", aliases: ["Agent Beta"] }
      ]
    }
  };
  const alreadyMentioned = planDiscordMentionCorrection(cfg, {
    request: {
      source: { botId: "111" },
      target: { guildId: "g1", channelId: "c1" },
      messageText: "Passo a Agent Beta <@222>."
    }
  });
  assert.equal(alreadyMentioned.reason, "mention_correction_skipped_bot_source");
  assert.equal(alreadyMentioned.nextAction, "none");

  const selfReference = planDiscordMentionCorrection(cfg, {
    request: {
      source: { botId: "111" },
      target: { guildId: "g1", channelId: "c1" },
      messageText: "Agent Alpha può continuare da solo."
    }
  });
  assert.equal(selfReference.reason, "mention_correction_skipped_bot_source");
});

test("mention correction skips controller service text without creating pings", () => {
  const cfg = {
    mode: "plan",
    discordAllowlist: [{ guildId: "g1", channelId: "c1" }],
    bridge: {
      participants: [
        { botId: "111", mention: "<@111>", label: "Agent Alpha", aliases: ["Agent Alpha"] },
        { botId: "222", mention: "<@222>", label: "Agent Beta", aliases: ["Agent Beta"] }
      ]
    }
  };

  const plan = planDiscordMentionCorrection(cfg, {
    request: {
      target: { guildId: "g1", channelId: "c1" },
      messageText: "Controller: Agent Gamma named Agent Alpha, Agent Beta without a valid Discord tag. The controller is applying the canonical tag so the turn can continue."
    }
  });

  assert.equal(plan.accepted, true);
  assert.equal(plan.reason, "mention_correction_skipped_controller_message");
  assert.equal(plan.nextAction, "none");
  assert.equal(plan.references, undefined);
});

test("mention correction skips structured event task messages", () => {
  const cfg = {
    mode: "plan",
    discordAllowlist: [{ guildId: "g1", channelId: "c1" }],
    bridge: {
      participants: [
        { botId: "111", mention: "<@111>", label: "Agent Alpha", aliases: ["Agent Alpha"] },
        { botId: "222", mention: "<@222>", label: "Agent Gamma", aliases: ["Agent Gamma"] }
      ]
    },
    eventController: {
      enabled: true,
      tasks: [{
        id: "multi-agent-smoke",
        sourceBotIds: ["111", "222"],
        target: { guildId: "g1", channelId: "c1" },
        itemPrefixes: ["AgentReport"],
        stopConditions: [{ type: "phrase", value: "Multi-agent test complete" }]
      }]
    }
  };

  const plan = planDiscordMentionCorrection(cfg, {
    request: {
      source: { botId: "222" },
      target: { guildId: "g1", channelId: "c1" },
      messages: [{ id: "m1", content: "AgentReport: Agent Gamma / waiting\nStatus: waiting for Agent Alpha" }]
    }
  });

  assert.equal(plan.reason, "mention_correction_skipped_event_task_message");
  assert.equal(plan.nextAction, "none");
});


test("mention correction skips unstructured messages in active event task channels", () => {
  const cfg = {
    mode: "plan",
    discordAllowlist: [{ guildId: "g1", channelId: "c1" }],
    bridge: {
      participants: [
        { botId: "111", mention: "<@111>", label: "Agent Alpha", aliases: ["Agent Alpha"] },
        { botId: "222", mention: "<@222>", label: "Agent Beta", aliases: ["Agent Beta"] }
      ]
    },
    eventController: {
      enabled: true,
      tasks: [{
        id: "multi-agent-smoke",
        sourceBotIds: ["111"],
        target: { guildId: "g1", channelId: "c1" },
        itemPrefixes: ["AgentReport"],
        stopConditions: [{ type: "phrase", value: "Multi-agent test complete" }]
      }]
    }
  };

  const plan = planDiscordMentionCorrection(cfg, {
    request: {
      source: { botId: "111" },
      target: { guildId: "g1", channelId: "c1" },
      messages: [{ id: "m1", content: "Waiting for Agent Beta before I continue." }]
    }
  });

  assert.equal(plan.reason, "mention_correction_skipped_event_task_channel");
  assert.equal(plan.nextAction, "none");
});

test("event task planner follows up on one container status without knowing total count", () => {
  const cfg = {
    mode: "plan",
    discordAllowlist: [{ guildId: "g1", channelId: "c1" }],
    bridge: {
      participants: [
        { botId: "111", mention: "<@111>", label: "Agent Alpha" },
        { botId: "222", mention: "<@222>", label: "Agent Beta" }
      ]
    },
    eventController: {
      enabled: true,
      tasks: [{
        id: "containers",
        sourceBotId: "111",
        sourceMention: "<@111>",
        target: { guildId: "g1", channelId: "c1" },
        itemLabel: "container"
      }]
    }
  };

  const plan = planDiscordEventTaskTurn(cfg, {
    request: {
      source: { botId: "111" },
      target: { guildId: "g1", channelId: "c1" },
      messages: [{
        id: "m1",
        content: "Container: CT 109 / `web-legacyplayer`\nStatus: running\nWarning: no deeper service health checked yet"
      }]
    },
    state: { status: "awaiting_status", seenMessageIds: [], itemCount: 0 }
  });

  assert.equal(plan.accepted, true);
  assert.equal(plan.reason, "event_task_follow_up_required");
  assert.equal(plan.nextAction, "send_follow_up_dry_run");
  assert.equal(plan.item, "CT 109 / `web-legacyplayer`");
  assert.equal(plan.stateTransition.itemCount, 1);
  assert.match(plan.followUpMessage, /continua con il prossimo container/);
  assert.equal(plan.sideEffectsAllowed, false);
});

test("event task planner stops only when the worker declares completion", () => {
  const cfg = {
    mode: "plan",
    discordAllowlist: [{ guildId: "g1", channelId: "c1" }],
    bridge: { participants: [{ botId: "111", mention: "<@111>", label: "Agent Alpha" }] },
    eventController: {
      enabled: true,
      tasks: [{
        id: "containers",
        sourceBotId: "111",
        target: { guildId: "g1", channelId: "c1" },
        stopConditions: [{ type: "phrase", value: "Inventory complete" }]
      }]
    }
  };

  const plan = planDiscordEventTaskTurn(cfg, {
    request: {
      source: { botId: "111" },
      target: { guildId: "g1", channelId: "c1" },
      messages: [{ id: "done-1", content: "Inventory complete." }]
    },
    state: { status: "awaiting_status", itemCount: 5 }
  });

  assert.equal(plan.accepted, true);
  assert.equal(plan.reason, "event_task_complete_declared");
  assert.equal(plan.nextAction, "stop");
  assert.equal(plan.stateTransition.status, "done");
  assert.equal(plan.stateTransition.itemCount, 5);
});

test("event task planner does not hardcode completion phrases", () => {
  const cfg = {
    mode: "plan",
    discordAllowlist: [{ guildId: "g1", channelId: "c1" }],
    bridge: { participants: [{ botId: "111", mention: "<@111>", label: "Agent Alpha" }] },
    eventController: {
      enabled: true,
      tasks: [{ id: "containers", sourceBotId: "111", target: { guildId: "g1", channelId: "c1" } }]
    }
  };

  const plan = planDiscordEventTaskTurn(cfg, {
    request: {
      source: { botId: "111" },
      target: { guildId: "g1", channelId: "c1" },
      messages: [{ id: "done-1", content: "Inventory complete." }]
    },
    state: { status: "awaiting_status", itemCount: 5 }
  });

  assert.equal(plan.accepted, true);
  assert.equal(plan.reason, "event_task_message_ignored");
  assert.equal(plan.nextAction, "none");
});

test("event task planner dedupes already seen worker messages", () => {
  const cfg = {
    mode: "plan",
    discordAllowlist: [{ guildId: "g1", channelId: "c1" }],
    bridge: { participants: [{ botId: "111", mention: "<@111>", label: "Agent Alpha" }] },
    eventController: {
      enabled: true,
      tasks: [{ id: "containers", sourceBotId: "111", target: { guildId: "g1", channelId: "c1" } }]
    }
  };

  const plan = planDiscordEventTaskTurn(cfg, {
    request: {
      source: { botId: "111" },
      target: { guildId: "g1", channelId: "c1" },
      messages: [{ id: "m1", content: "Container: CT 109\nStatus: running" }]
    },
    state: { seenMessageIds: ["m1"], itemCount: 1 }
  });

  assert.equal(plan.accepted, true);
  assert.equal(plan.reason, "event_task_duplicate_message");
  assert.equal(plan.nextAction, "none");
});

test("event task planner uses low-trust LLM advisor for ambiguous status only above threshold", () => {
  const cfg = {
    mode: "plan",
    discordAllowlist: [{ guildId: "g1", channelId: "c1" }],
    bridge: { participants: [{ botId: "111", mention: "<@111>", label: "Agent Alpha" }] },
    eventController: {
      enabled: true,
      llmAdvisor: { enabled: true, confidenceThreshold: 0.75 },
      tasks: [{ id: "containers", sourceBotId: "111", sourceMention: "<@111>", target: { guildId: "g1", channelId: "c1" } }]
    }
  };

  const high = planDiscordEventTaskTurn(cfg, {
    request: {
      source: { botId: "111" },
      target: { guildId: "g1", channelId: "c1" },
      messages: [{ id: "m1", content: "Questo container sembra ok." }]
    },
    advisor: { classification: "status_update", confidence: 0.9, item: "CT 109", status: "running" }
  });
  assert.equal(high.reason, "event_task_llm_status_advised");
  assert.equal(high.nextAction, "send_follow_up_dry_run");
  assert.equal(high.item, "CT 109");

  const low = planDiscordEventTaskTurn(cfg, {
    request: {
      source: { botId: "111" },
      target: { guildId: "g1", channelId: "c1" },
      messages: [{ id: "m2", content: "Credo sia finita." }]
    },
    advisor: { classification: "complete", confidence: 0.6 }
  });
  assert.equal(low.reason, "event_task_llm_low_confidence_confirmation_required");
  assert.equal(low.nextAction, "send_confirmation_dry_run");
  assert.match(low.confirmationMessage, /vuoi davvero chiudere/);
});

test("event task planner gates LLM handoff through participant allowlist and asks confirmation when low confidence", () => {
  const cfg = {
    mode: "plan",
    discordAllowlist: [{ guildId: "g1", channelId: "c1" }],
    bridge: {
      participants: [
        { botId: "111", mention: "<@111>", label: "Agent Alpha" },
        { botId: "222", mention: "<@222>", label: "Agent Beta", aliases: ["Agent Beta"] }
      ]
    },
    eventController: {
      enabled: true,
      llmAdvisor: { enabled: true, confidenceThreshold: 0.75 },
      tasks: [{ id: "containers", sourceBotId: "111", sourceMention: "<@111>", target: { guildId: "g1", channelId: "c1" } }]
    }
  };

  const high = planDiscordEventTaskTurn(cfg, {
    request: {
      source: { botId: "111" },
      target: { guildId: "g1", channelId: "c1" },
      messages: [{ id: "m1", content: "Agent Beta dovrebbe dare un'occhiata." }]
    },
    advisor: { classification: "handoff", confidence: 0.82, targetAgentLabel: "Agent Beta" }
  });
  assert.equal(high.reason, "event_task_llm_handoff_advised");
  assert.equal(high.nextAction, "send_handoff_dry_run");
  assert.match(high.handoffMessage, /^<@222>/);

  const low = planDiscordEventTaskTurn(cfg, {
    request: {
      source: { botId: "111" },
      target: { guildId: "g1", channelId: "c1" },
      messages: [{ id: "m2", content: "Forse Agent Beta?" }]
    },
    advisor: { classification: "handoff", confidence: 0.5, targetAgentLabel: "Agent Beta" }
  });
  assert.equal(low.reason, "event_task_llm_low_confidence_confirmation_required");
  assert.equal(low.nextAction, "send_confirmation_dry_run");
});

test("event task planner normalizes unknown advisor enum to ambiguous confirmation", () => {
  const cfg = {
    mode: "plan",
    discordAllowlist: [{ guildId: "g1", channelId: "c1" }],
    bridge: { participants: [{ botId: "111", mention: "<@111>", label: "Agent Alpha" }] },
    eventController: {
      enabled: true,
      llmAdvisor: { enabled: true, confidenceThreshold: 0.75 },
      tasks: [{ id: "containers", sourceBotId: "111", sourceMention: "<@111>", target: { guildId: "g1", channelId: "c1" } }]
    }
  };

  const plan = planDiscordEventTaskTurn(cfg, {
    request: {
      source: { botId: "111" },
      target: { guildId: "g1", channelId: "c1" },
      messages: [{ id: "m1", content: "Maybe this is complete." }]
    },
    advisor: { classification: "maybe_done", confidence: 0.9 }
  });

  assert.equal(plan.reason, "event_task_llm_advice_unusable");
  assert.equal(plan.nextAction, "send_confirmation_dry_run");
  assert.equal(plan.advisor.classification, "ambiguous");
});

test("event task planner supports task-specific item prefixes", () => {
  const cfg = {
    mode: "plan",
    discordAllowlist: [{ guildId: "g1", channelId: "c1" }],
    bridge: { participants: [{ botId: "111", mention: "<@111>", label: "Agent Alpha" }] },
    eventController: {
      enabled: true,
      tasks: [{
        id: "network-inventory",
        sourceBotId: "111",
        sourceMention: "<@111>",
        target: { guildId: "g1", channelId: "c1" },
        itemLabel: "node/user",
        itemPrefixes: ["Node", "User"],
        stopConditions: [{ type: "phrase", value: "Network inventory complete" }]
      }]
    }
  };

  const nodePlan = planDiscordEventTaskTurn(cfg, {
    request: {
      taskId: "network-inventory",
      source: { botId: "111" },
      target: { guildId: "g1", channelId: "c1" },
      messages: [{ id: "n1", content: "Node: lab-node\nStatus: online\nWarning: none" }]
    },
    state: { status: "awaiting_status", itemCount: 0 }
  });
  assert.equal(nodePlan.reason, "event_task_follow_up_required");
  assert.equal(nodePlan.item, "lab-node");
  assert.match(nodePlan.followUpMessage, /prossimo node\/user/);
  assert.match(nodePlan.followUpMessage, /Network inventory complete/);
  assert.doesNotMatch(nodePlan.followUpMessage, /“Inventory complete”/);

  const userPlan = planDiscordEventTaskTurn(cfg, {
    request: {
      taskId: "network-inventory",
      source: { botId: "111" },
      target: { guildId: "g1", channelId: "c1" },
      messages: [{ id: "u1", content: "User: admin@example.invalid\nStatus: active" }]
    },
    state: { status: "awaiting_status", itemCount: 1 }
  });
  assert.equal(userPlan.reason, "event_task_follow_up_required");
  assert.equal(userPlan.item, "admin@example.invalid");
});

test("event task planner supports multiple source bots for one task", () => {
  const cfg = {
    mode: "plan",
    discordAllowlist: [{ guildId: "g1", channelId: "c1" }],
    bridge: { participants: [
      { botId: "111", mention: "<@111>", label: "Agent Alpha" },
      { botId: "222", mention: "<@222>", label: "Agent Gamma" }
    ] },
    eventController: {
      enabled: true,
      tasks: [{
        id: "multi-agent-smoke",
        sourceBotIds: ["111", "222"],
        target: { guildId: "g1", channelId: "c1" },
        itemLabel: "agent report",
        itemPrefixes: ["AgentReport"],
        stopConditions: [{ type: "phrase", value: "Multi-agent test complete" }]
      }]
    }
  };

  const plan = planDiscordEventTaskTurn(cfg, {
    request: {
      taskId: "multi-agent-smoke",
      source: { botId: "222" },
      target: { guildId: "g1", channelId: "c1" },
      messages: [{ id: "r1", content: "AgentReport: Agent Gamma / runner\nStatus: ready" }]
    },
    state: { status: "awaiting_status", itemCount: 0 }
  });
  assert.equal(plan.reason, "event_task_follow_up_required");
  assert.equal(plan.item, "Agent Gamma / runner");
  assert.match(plan.followUpMessage, /^<@222>/);
  assert.match(plan.followUpMessage, /Multi-agent test complete/);
});

test("event task planner requires and propagates explicit run ids for scoped live runs", () => {
  assert.equal(extractEventTaskRunId("AgentReport: A\nRunId: smoke-v4-001"), "smoke-v4-001");
  assert.equal(extractEventTaskRunId("Finding: B\nOrchId: orch-2026-05-16"), "orch-2026-05-16");

  const cfg = {
    mode: "plan",
    discordAllowlist: [{ guildId: "g1", channelId: "c1" }],
    bridge: { participants: [{ botId: "111", mention: "<@111>", label: "Agent Alpha" }] },
    eventController: {
      enabled: true,
      tasks: [{
        id: "multi-agent-smoke-v4",
        runIdRequired: true,
        sourceBotIds: ["111"],
        target: { guildId: "g1", channelId: "c1" },
        itemLabel: "agent report",
        itemPrefixes: ["AgentReport"],
        stopConditions: [{ type: "phrase", value: "Multi-agent test complete" }]
      }]
    }
  };

  const missing = planDiscordEventTaskTurn(cfg, {
    request: {
      taskId: "multi-agent-smoke-v4",
      source: { botId: "111" },
      target: { guildId: "g1", channelId: "c1" },
      messages: [{ id: "r0", content: "AgentReport: Agent Alpha / runtime\nStatus: ready" }]
    },
    state: { status: "awaiting_status", itemCount: 0 }
  });
  assert.equal(missing.reason, "event_task_run_id_required");
  assert.equal(missing.nextAction, "send_confirmation_dry_run");
  assert.match(missing.confirmationMessage, /RunId/);

  const scoped = planDiscordEventTaskTurn(cfg, {
    request: {
      taskId: "multi-agent-smoke-v4",
      source: { botId: "111" },
      target: { guildId: "g1", channelId: "c1" },
      messages: [{ id: "r1", content: "AgentReport: Agent Alpha / runtime\nStatus: ready\nRunId: smoke-v4-001" }]
    },
    state: { status: "awaiting_status", itemCount: 0 }
  });
  assert.equal(scoped.reason, "event_task_follow_up_required");
  assert.equal(scoped.runId, "smoke-v4-001");
  assert.equal(scoped.stateTransition.runId, "smoke-v4-001");
});

test("event task planner does not reopen a completed run for same RunId replay", () => {
  const cfg = {
    mode: "plan",
    discordAllowlist: [{ guildId: "g1", channelId: "c1" }],
    bridge: { participants: [{ botId: "111", mention: "<@111>", label: "Agent Alpha" }] },
    eventController: {
      enabled: true,
      tasks: [{
        id: "multi-agent-smoke-v4",
        runIdRequired: true,
        sourceBotIds: ["111"],
        phaseSourceBotIds: [["111"]],
        target: { guildId: "g1", channelId: "c1" },
        itemLabel: "agent report",
        itemPrefixes: ["AgentReport"],
        requiredSourceBotIds: ["111"],
        requireAllSourcesBeforeComplete: true,
        stopConditions: [{ type: "phrase", value: "Multi-agent test complete" }]
      }]
    }
  };

  const replay = planDiscordEventTaskTurn(cfg, {
    request: {
      taskId: "multi-agent-smoke-v4",
      source: { botId: "111" },
      target: { guildId: "g1", channelId: "c1" },
      messages: [{ id: "replay1", content: "AgentReport: Agent Alpha / duplicate\nStatus: ready\nRunId: smoke-v4-001" }]
    },
    state: {
      status: "done",
      runId: "smoke-v4-001",
      itemCount: 1,
      phaseIndex: 0,
      seenSourceBotIds: ["111"],
      sourceReportCounts: { "111": 1 }
    }
  });

  assert.equal(replay.reason, "event_task_already_done");
  assert.equal(replay.nextAction, "none");
  assert.equal(replay.stateTransition, undefined);
});

test("event task planner only enables the current phase source and expands deliberately", () => {
  const cfg = {
    mode: "plan",
    discordAllowlist: [{ guildId: "g1", channelId: "c1" }],
    bridge: { participants: [{ botId: "111" }, { botId: "222" }, { botId: "333" }] },
    eventController: {
      enabled: true,
      tasks: [{
        id: "multi-agent-smoke",
        sourceBotIds: ["111", "222", "333"],
        phaseSourceBotIds: [["111"], ["222"], ["333"]],
        requiredSourceBotIds: ["111", "222", "333"],
        requireAllSourcesBeforeComplete: true,
        target: { guildId: "g1", channelId: "c1" },
        itemLabel: "agent report",
        itemPrefixes: ["AgentReport"],
        stopConditions: [{ type: "phrase", value: "Multi-agent test complete" }]
      }]
    }
  };

  const blocked = planDiscordEventTaskTurn(cfg, {
    request: {
      taskId: "multi-agent-smoke",
      source: { botId: "222" },
      target: { guildId: "g1", channelId: "c1" },
      messages: [{ id: "r0", content: "AgentReport: Agent Gamma / runner\nStatus: too early" }]
    },
    state: { status: "awaiting_status", itemCount: 0, phaseIndex: 0 }
  });
  assert.equal(blocked.reason, "event_task_source_not_enabled_for_current_phase");
  assert.equal(blocked.nextAction, "none");

  const phaseOne = planDiscordEventTaskTurn(cfg, {
    request: {
      taskId: "multi-agent-smoke",
      source: { botId: "111" },
      target: { guildId: "g1", channelId: "c1" },
      messages: [{ id: "r1", content: "AgentReport: Agent Alpha / runtime\nStatus: ready" }]
    },
    state: { status: "awaiting_status", itemCount: 0, phaseIndex: 0 }
  });

  assert.equal(phaseOne.reason, "event_task_follow_up_required");
  assert.equal(phaseOne.stateTransition.phaseIndex, 1);
  assert.match(phaseOne.followUpMessage, /<@222>/);
  assert.doesNotMatch(phaseOne.followUpMessage, /<@333>/);
  assert.doesNotMatch(phaseOne.followUpMessage, /<@111>/);

  const finalPhase = planDiscordEventTaskTurn(cfg, {
    request: {
      taskId: "multi-agent-smoke",
      source: { botId: "333" },
      target: { guildId: "g1", channelId: "c1" },
      messages: [{ id: "r3", content: "AgentReport: Agent Beta / runtime\nStatus: done" }]
    },
    state: {
      status: "awaiting_status",
      itemCount: 2,
      phaseIndex: 2,
      seenSourceBotIds: ["111", "222"],
      sourceReportCounts: { "111": 1, "222": 1 }
    }
  });
  assert.equal(finalPhase.reason, "event_task_auto_completed");
  assert.equal(finalPhase.stateTransition.status, "done");
  assert.match(finalPhase.followUpMessage, /marcato automaticamente come completato/);

  const restarted = planDiscordEventTaskTurn(cfg, {
    request: {
      taskId: "multi-agent-smoke",
      source: { botId: "111" },
      target: { guildId: "g1", channelId: "c1" },
      messages: [{ id: "r2", content: "AgentReport: Agent Alpha / runtime\nStatus: restarted" }]
    },
    state: { status: "done", itemCount: 3, phaseIndex: 2, seenSourceBotIds: ["111", "222", "333"] }
  });
  assert.equal(restarted.reason, "event_task_follow_up_required");
  assert.equal(restarted.stateTransition.phaseIndex, 1);
});

test("event task planner blocks premature multi-source completion", () => {
  const cfg = {
    mode: "plan",
    discordAllowlist: [{ guildId: "g1", channelId: "c1" }],
    bridge: { participants: [{ botId: "111" }, { botId: "222" }] },
    eventController: {
      enabled: true,
      tasks: [{
        id: "multi-agent-smoke",
        sourceBotIds: ["111", "222"],
        requiredSourceBotIds: ["111", "222"],
        requireAllSourcesBeforeComplete: true,
        target: { guildId: "g1", channelId: "c1" },
        itemLabel: "agent report",
        itemPrefixes: ["AgentReport"],
        stopConditions: [{ type: "phrase", value: "Multi-agent test complete" }]
      }]
    }
  };

  const plan = planDiscordEventTaskTurn(cfg, {
    request: {
      taskId: "multi-agent-smoke",
      source: { botId: "111" },
      target: { guildId: "g1", channelId: "c1" },
      messages: [{ id: "done1", content: "Multi-agent test complete" }]
    },
    state: { status: "awaiting_status", itemCount: 1, seenSourceBotIds: ["111"] }
  });

  assert.equal(plan.reason, "event_task_complete_before_required_sources");
  assert.equal(plan.nextAction, "none");
  assert.deepEqual(plan.missingSourceBotIds, ["222"]);
});

test("event task planner suppresses repeated reports from a capped source", () => {
  const cfg = {
    mode: "plan",
    discordAllowlist: [{ guildId: "g1", channelId: "c1" }],
    bridge: { participants: [{ botId: "111" }, { botId: "222" }] },
    eventController: {
      enabled: true,
      tasks: [{
        id: "multi-agent-smoke",
        sourceBotIds: ["111", "222"],
        requiredSourceBotIds: ["111", "222"],
        maxReportsPerSource: 1,
        target: { guildId: "g1", channelId: "c1" },
        itemLabel: "agent report",
        itemPrefixes: ["AgentReport"],
        stopConditions: [{ type: "phrase", value: "Multi-agent test complete" }]
      }]
    }
  };

  const plan = planDiscordEventTaskTurn(cfg, {
    request: {
      taskId: "multi-agent-smoke",
      source: { botId: "111" },
      target: { guildId: "g1", channelId: "c1" },
      messages: [{ id: "repeat1", content: "AgentReport: A / duplicate\nStatus: no-op" }]
    },
    state: { status: "awaiting_status", itemCount: 1, seenSourceBotIds: ["111"], sourceReportCounts: { "111": 1 } }
  });

  assert.equal(plan.reason, "event_task_source_report_limit_reached");
  assert.equal(plan.nextAction, "none");
  assert.equal(plan.followUpMessage, undefined);
});
