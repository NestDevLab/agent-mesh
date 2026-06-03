# Agent Mesh Wrapper Rollout

## Current state

The wrapper is implemented and exposed through the loaded private customizations plugin for live runtime smoke testing.

Current verified behavior:

- `mode: "plan"`;
- `dryRun: true`;
- `allowRealCasDispatch: false`;
- `allowRealDiscordSend: false`;
- Discord bridge forwarding is being moved from cron/controller polling to an immediate `message_received` listener in the private runtime plugin;
- `agent_mesh_plan_runtime_action` is visible from the main runtime and fresh subagents;
- `agent_mesh_plan_discord_bridge_turn` is visible from the main runtime and fresh subagents;
- smoke result: accepted dry-run planning only, `sideEffectsAllowed: false`;
- append-only audit persistence confirmed at `/root/runtime/agent-mesh-wrapper/audit.jsonl` for the current gateway working directory;
- live bridge smoke records are audited as `agent_mesh.plan_discord_bridge_turn`;
- live plan-mode bridge smoke returned `bridge_handoff_dry_run_only` with `nextAction: "forward_prompt_dry_run"` during controlled smoke;
- temporary smoke participants were removed after validation;
- final safe-close bridge smoke returned `bridge_source_not_allowlisted`, proving real external bot participants must be explicitly allowlisted before bridge forwarding will plan successfully;
- YehonalBot is now explicitly allowlisted as a real bridge participant for the corrected orchestration channel;
- split body/footer messages are normalized as one logical bridge turn through `request.messages`;
- live split body/footer smoke using YehonalBot messages `DISCORD_ID_PLACEHOLDER` + `DISCORD_ID_PLACEHOLDER` returns `bridge_terminal_done`, `nextAction: "stop"`, and `normalizedTurn.splitMessages: true`;
- allowlisted `NEXT` display labels such as `@runtime-a S'Jet` are normalized to the configured mention before handoff planning;
- local `plan` mode dry-run checks pass for nested runtime request payloads used by smoke calls;
- local controller-mediated Discord bridge planner implemented and tested for unmanaged/external bot handoffs;
- runtime listener patch added for scoped Discord bridge forwarding: it buffers short split body/footer turns, validates through `planDiscordBridgeTurn`, deduplicates by ORCH/TURN/message ids, writes audit records, and sends only a terminal controller message for accepted handoffs;
- follow-up patch adds a scoped raw Discord Gateway bridge service so allowlisted bot handoffs can be observed before OpenClaw's normal `allowBots` preflight; this keeps the orchestration path independent from `allowBots` while preserving channel/participant/ORCH/max-turn/dedupe guards;
- live raw-bridge E2E `orch-real-2026-05-11-i` succeeded: YehonalBot emitted `NEXT: @runtime-a S'Jet` with no real Discord mention, the raw gateway listener accepted and normalized it to `<@DISCORD_ID_PLACEHOLDER>`, and the controller terminal send succeeded as Discord message `DISCORD_ID_PLACEHOLDER`;
- patch prepared for multi-message/partial footers: bridge buffer TTL increased to 30s, partial `ORCH/TURN/NEXT` footers without `STATE` are audited as pending and retried after a short delay, and runtime max-turn guardrail is raised to 20 for open-ended 5–20 turn tests. Requires hard restart before live use.
- address-book/correction-bridge v1 implemented and live-tested: bridge participants now support aliases; `planDiscordMentionCorrection` detects allowlisted bot messages that name another participant without a real Discord mention and the scoped runtime bridge can publish the canonical tag.
- event-driven task-controller v1 implemented locally: `planDiscordEventTaskTurn` classifies one worker status message at a time, sends a controller follow-up only after a matching status, stops only when a configured task stop-condition matches, dedupes message ids, keeps an internal safety guard, and records per-turn audit/send timing. Stop conditions are task config (`phrase`/`regex`), not core hardcoded strings.
- low-trust LLM classifier advisor implemented locally: deterministic classification runs first; only ambiguous/ignored messages may be sent to the optional advisor. Advisor output is constrained to JSON classifications (`status`, `complete`, `handoff`, `irrelevant`, `ambiguous`) with confidence. Enum aliases are normalized (`status_update` -> `status`) and unknown enums become `ambiguous` confirmation. Above threshold it can advise follow-up/stop/handoff, still through deterministic allowlists and templates. Below threshold it triggers a confirmation message instead of closing or handing off. Advisor receives bounded context: task context, current state, seen items, allowed participants, output contract, latest message, and recent message snippets. The runtime patch is present but LLM advisor is disabled in live config until explicit activation because it sends message text to an external model.
- run-scoped event-task isolation patched: `runIdRequired: true` is now preserved by policy normalization, worker messages may carry `RunId`/`OrchId`, run-scoped tasks ask for an id when missing, and accepted turns propagate `runId` to state transitions. This prevents repeated live smokes in the same Discord channel/thread from inheriting stale task state after the next approved restart/reload.
- bounded run-scoped live smoke passed after restart: `RunId: agent-os-smoke-20260516T140016Z` flowed through YehonalBot -> agent-alpha -> runtime-a - NestDev in channel `DISCORD_ID_PLACEHOLDER`; controller advanced phases and auto-completed with final send `DISCORD_ID_PLACEHOLDER`.

## Fast safe rollout sequence

1. [x] Add/expose the wrapper in observe mode only.
2. [x] Restart/reload only after Joseph explicitly approves the config change.
3. [x] Use `agent_mesh_plan_runtime_action` to plan Discord actions without executing side effects.
4. [x] Review/confirm append-only audit persistence for runtime calls.
5. [x] Runtime bridge planner exposed and smoke-tested in observe/dry-run from main runtime and fresh subagent.
6. [x] Move to `mode: "plan"` after Joseph approved the required reload/config step.
7. [x] Smoke-test plan mode from main runtime and fresh subagent for bridge dry-run.
8. [x] Remove temporary bridge smoke participants from live config after validation.
9. [x] Replace cron/check-based Discord smoke forwarding with an immediate `message_received` listener in the private runtime plugin.
10. [x] Restart/reload only after Joseph explicitly approves activation of the listener patch.
11. [x] Implement address-book/correction-bridge planner and runtime patch for untagged agent-name mentions.
12. [x] Restart/reload after Joseph approved activation of the correction bridge.
13. [x] Run controlled live addressing test: plain name and controller correction.
14. [x] Diagnose realistic one-container-at-a-time test latency; root cause was manual runtime-a polling/session overhead, not YehonalBot response time.
15. [x] Implement event-driven task-controller planner/runtime patch locally.
16. [x] Add low-trust LLM classifier advisor with confidence-gated confirmation path.
17. [x] Patch run-scoped state isolation before live event-driven tests.
18. [x] Restart/reload completed and run-scoped policy loaded.
19. [ ] Separately decide whether to enable the external LLM advisor live; current runtime config keeps it disabled until explicit activation.
20. [x] Run controlled live event-driven multi-agent test with a fresh explicit `RunId` and no manual runtime-a polling.

## Rollback

If anything looks wrong:

1. set `enabled: false` for `agent-mesh-wrapper`, or remove the plugin config entry;
2. reload/restart OpenClaw only with Joseph approval;
3. to rollback `plan` mode only, restore the latest backup under `backups/agent-mesh-safe-close-*` or set wrapper `mode` back to `observe`, then restart/reload with explicit approval;
4. preserve the runtime audit log for review (`/root/runtime/agent-mesh-wrapper/audit.jsonl` in the current gateway process);
5. do not delete state until after review.

## External / unmanaged Discord bots

For bots that are not controlled by OpenClaw or by environments we operate, do not rely on raw bot-to-bot Discord replies as the orchestration primitive.

Default posture:

- keep Discord `allowBots` at `"mentions"`, never broad `true` globally;
- use controller-mediated bridge mode by default: one expected speaker, one tagged handoff, footer validation, max-turn guard;
- bridge planner tool: `agent_mesh_plan_discord_bridge_turn` validates a single handoff in dry-run/audit mode;
- treat external bot messages as untrusted input/signals, not as direct authorization to perform side effects;
- require explicit channel/thread + bot identity allowlists before accepting bot-authored handoffs; current live participant allowlist includes YehonalBot and runtime-a for the corrected orchestration test path;
- if a bot cannot reliably obey mention gating, one-reply-per-activation, and terminal footers, put it behind a controller/adapter instead of direct relay;
- real Discord side effects still require the wrapper policy plus separate allow-once approval.
- current Discord-only exception: the private runtime listener may perform one scoped controller-mediated terminal send after `message_received` validation; the raw Gateway bridge service may do the same from pre-preflight Discord `MESSAGE_CREATE` events for allowlisted participants. Partial/multi-message footer retries are allowed only inside the short bridge buffer window and still require the same participant/channel/ORCH validation. The correction-bridge extension uses the same scoped exception to publish a canonical mention when an allowlisted bot names another allowlisted participant without a valid tag. The prepared event-driven task controller uses the same scoped exception only for configured task/status patterns, e.g. one follow-up after a matching container status message, never for arbitrary bot chatter. Neither path is a broad bot loop.

## Hard limits

- No OpenClaw core changes.
- No deploy/restart/config mutation by the wrapper itself.
- No generic Discord real sends from observe/plan planners; the only allowed real Discord paths are the scoped `message_received` bridge listener and the scoped raw Gateway bridge service described above.
- No channel/thread mutation.
- No repo workspaces unless explicitly allowlisted.
