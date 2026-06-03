# CAS Team Plan

This package has moved past the initial scaffold. Jobs A-D produced the Phase 1 implementation slice, Jobs E/F produced review and QA findings, and Job G addressed the first integration fixes.

## Job A: Scaffold Owner

Created the package skeleton, package metadata, docs, config placeholders, and empty or minimal module exports.

## Completed Jobs

- Job B: implement schemas and validation.
- Job C: implement append-only NDJSON stores and restart safety.
- Job D: implement gateway core, registries, adapters, and demo entrypoints.
- Job E: review security and policy boundaries.
- Job F: run integration QA for tests and demos.
- Job G: persist gateway control state, harden content-hash anti-loop behavior, emit startup recovery audit events, make demos rerun-safe, persist request/reply demo replies, strengthen Discord transcript correlation stubs, and document current implementation scope.
- Job K: implement stub-safe Memory Fabric proposal/decision schemas, append-only local policy evaluation store, deterministic policy selector/gate, and deny/allow-once/ask-human tests.
- Job L: implement stub-safe Proactivity Engine schemas, local NDJSON stores, and stale-backlog proposal selectors with tests.
- Job M: implement stub-safe model/reasoning profile selection schema, deterministic advisory selector, and CAS team-sizing helper with tests.
- Job N: implement stub-safe Phase 2 inspection/demo path tying Memory Fabric, Proactivity, model selection, and CAS team sizing together without real adapters.
- Job O: implement stub-only CAS runner plan facade with local NDJSON store and no real CAS/codex_workers dispatch.
- Job P: implement stub-only Discord delivery planner with local NDJSON store and no OpenClaw message/Discord calls.
- Job R: implement stub-only unified policy decision record, shared risk classifier, local NDJSON store, and subject mapping tests for execution jobs/CAS runner plans, memory actions, Discord delivery, proactivity, and model selection.
- Job S: implement controlled real CAS runner adapter boundary with an injectable dispatcher interface, strict dispatch gates, local CAS dispatch attempt/result records, and fake-dispatcher tests proving dispatch occurs exactly once only for the approved case.
- Job T: implement the controlled real Discord adapter boundary. The package still does not call the OpenClaw message tool directly; real send execution is possible only through an injected sender interface after explicit `enable_real_send`, an `allow-once` policy decision for the exact delivery plan, an allowed dry-run plan, configured target, acceptable sensitivity/redaction, non-empty idempotency key, accepted kill-switch/pause guard, and explicit message-create permission. Tests use a fake sender only.
- Job U: wire unified policy decisions into the Phase 2/3 completion demo so Memory Fabric, Proactivity, model selection, CAS runner plan/dispatch, and Discord delivery/send planning all emit or include common `openclaw.agent.policy_decision.v1` records. The completion demo uses injected fake dispatcher/sender boundaries only and reports whether those fakes were called.
- Job V: implement the runtime CAS host binding facade that adapts `CasRunnerDispatcher` to a host-provided invocation function. The facade builds strict host requests with `endpointId`, `workspaceDir`, `threadName`, prompt guardrails, and safety metadata; temp-workspace smoke mode is enforced by default.
- Job W: implement the safe runtime Discord binding facade. Added `OpenClawHostMessageSender`, which adapts the existing `DiscordMessageSender` interface to an injected host function shaped like OpenClaw `message/send`, translates requests to strict `channel: "discord"` dry-run/smoke host payloads, rejects real sends by default, and keeps the package free of direct OpenClaw message-tool imports/calls.
- Job X: implement a local runtime host-binding smoke wrapper under `src/demo/runtime-host-binding-smoke.ts`. The wrapper builds sample CAS and Discord host requests through the existing facades, exercises them with injected fake host functions only, and prints deterministic dry-run JSON with explicit no-core-config/no-direct-tool-call guardrails.

## Next Jobs

- Job H: design Memory Fabric policy gate. Done in `docs/memory-fabric-policy.md`: no central Memory Broker by default; cross-host prompt/artifact/synced-folder handoff and same-host mem0/local-folder scope rules are documented.
- Job I: design Proactivity Engine and the general self-improvement contract for every proactive agent, with the Project Manager / Chief of Staff backlog hygiene loop as one example. Done in `docs/proactivity-engine.md`.
- Job J: design agent model/reasoning profile policy by role, task type, complexity, risk, latency and cost. Done in `docs/model-reasoning-policy.md`.

## Upcoming Implementation Jobs

- Job Q: maintain broader policy/approval refinement roadmap. Started in `docs/policy-refinement-roadmap.md`.
- No unassigned completion job currently remains for the Phase 2/3 policy demo wiring.

## Latest Verification

2026-05-10 19:12 UTC:

- Backup before runtime wrapper: `backups/openclaw-agent-mesh-gateway-20260510T1907UTC-pre-runtime-wrapper.tar.gz`.
- Added local runtime wrapper/demo `src/demo/runtime-host-binding-smoke.ts` plus tests.
- Wrapper constructs deterministic dry-run CAS and Discord host-binding requests through existing facades, using injected fake host functions only.
- Verification in the real package:
  - `npm test` passed: 99 tests, 99 pass, 0 fail.
  - `/root/.local/lib/node_modules/openclaw/node_modules/.bin/tsc -p tsconfig.json --noEmit` passed.
  - `/root/.local/lib/node_modules/openclaw/node_modules/.bin/tsc -p tsconfig.json` passed.
  - Direct wrapper smoke command passed and printed explicit guardrails.
- Guardrails preserved: no OpenClaw core/runtime config changes, no real messages, no package calls to `codex_workers_run_task`, no push/publish/deploy/restart/delete, no secret access, and no out-of-scope edits.

2026-05-10 18:50 UTC:

- Backup before real smoke: `backups/openclaw-agent-mesh-gateway-20260510T1846UTC-pre-real-smoke.tar.gz`.
- Real CAS repo smoke completed via `agent-mesh/smoke-real-cas-repo-allow-once`.
- CAS changed exactly one package file: `test/controlled-discord-adapter.test.js`, adding a guard test for `guards.accepted=false`.
- Verification in the real package:
  - `npm test` passed: 95 tests, 95 pass, 0 fail.
  - `/root/.local/lib/node_modules/openclaw/node_modules/.bin/tsc -p tsconfig.json --noEmit` passed.
  - `/root/.local/lib/node_modules/openclaw/node_modules/.bin/tsc -p tsconfig.json` passed.
- Real Discord smoke sent to approved channel/thread `DISCORD_ID_PLACEHOLDER`; message id `DISCORD_ID_PLACEHOLDER`.
- Guardrails preserved: no push/publish/deploy/restart/delete, no OpenClaw core/runtime config changes, no secret access, and no out-of-scope file edits.

2026-05-10 19:06 UTC:

- Added local runtime host-binding smoke wrapper:

```bash
node --import ./test/ts-extension-resolver.mjs -e 'import("./src/demo/runtime-host-binding-smoke.ts").then(async (m) => console.log(JSON.stringify(await m.buildRuntimeHostBindingSmokeDemo(), null, 2)))'
```

- Demo output includes both `CasHostBindingFacade` / `createHostCasInvocationRequest` and `OpenClawHostMessageSender` / `toHostMessageSendRequest` request shapes.
- Tests prove deterministic output, required guardrail fields, fake CAS/Discord invoker call counts, and no direct OpenClaw tool, `codex_workers_run_task`, or real send path.
- Guardrails preserved: no OpenClaw core/runtime config changes, no real OpenClaw tool calls, no direct `codex_workers` calls, no real Discord send, no push/publish/deploy/restart/delete, and no out-of-scope file edits.

2026-05-10 18:38 UTC:

- Backup before tranche: `backups/openclaw-agent-mesh-gateway-20260510T1829UTC.tar.gz`.
- Jobs V/W completed safe runtime host binding facades:
  - `CasHostBindingFacade` for host-provided CAS invocation, `/tmp` smoke mode by default.
  - `OpenClawHostMessageSender` for host-provided Discord/message sending, dry-run by default and real sends rejected by default.
- Verification in the package:
  - `npm test` passed: 94 tests, 94 pass, 0 fail.
  - `/root/.local/lib/node_modules/openclaw/node_modules/.bin/tsc -p tsconfig.json --noEmit` passed.
  - `/root/.local/lib/node_modules/openclaw/node_modules/.bin/tsc -p tsconfig.json` passed.
  - Phase 2/3 completion demo passed.
- Host-binding smoke generated a CAS request through `CasHostBindingFacade` for `/tmp/openclaw-agent-mesh-host-binding-smoke-20260510T183638Z`, dispatched it via CAS, and verified `npm test` passed with marker `agent-mesh-host-binding-smoke: passed`.
- Guardrails preserved: no OpenClaw core/runtime config changes, no direct package imports/calls to OpenClaw tools or `codex_workers_run_task`, no real Discord send, no push/publish/deploy/restart/delete, and no non-temp CAS workspace mutation.

2026-05-10 Job W:

- Backup available before this tranche: `backups/openclaw-agent-mesh-gateway-20260510T1829UTC.tar.gz`.
- Added runtime host message sender facade and fake-host tests for dry-run success, default real-send rejection, deterministic channel/thread mapping, and host failure error propagation.
- Guardrails preserved: no OpenClaw core/runtime config changes, no direct OpenClaw message tool calls, no real Discord send, and no external side effects from the package.

2026-05-10 17:18 UTC:

- Backup before continuation: `backups/openclaw-agent-mesh-gateway-20260510T1711UTC.tar.gz`.
- `npm test` passed: 65 tests, 65 pass, 0 fail.
- `/root/.local/lib/node_modules/openclaw/node_modules/.bin/tsc -p tsconfig.json --noEmit` passed.
- Phase 2 demo command passed via `src/demo/demo-phase2-policy.ts`.
- CAS/Discord real adapters remain disabled; new planners are local record-only stubs.

2026-05-10 17:40 UTC:

- Backup before Job R: `backups/openclaw-agent-mesh-gateway-20260510T1738UTC.tar.gz`.
- Job R completed as a local package-only stub.
- Added `openclaw.agent.policy_decision.v1`, shared risk classifier, and local policy-decision NDJSON store.
- `npm test` passed: 71 tests, 71 pass, 0 fail.
- `/root/.local/lib/node_modules/openclaw/node_modules/.bin/tsc -p tsconfig.json --noEmit` passed.

2026-05-10 18:05 UTC:

- Backup already present before Job S: `backups/openclaw-agent-mesh-gateway-20260510T1745UTC.tar.gz`.
- Job S completed inside `openclaw-agent-mesh-gateway` only.
- Added strict injectable CAS dispatch adapter boundary, local `cas-runner-dispatch.ndjson` store, and dispatch record schema.
- Tests use a fake dispatcher only; no real CAS, OpenClaw tool, or `codex_workers` calls are made.
- `npm test` passed: 14 files, 14 pass, 0 fail.
- `/root/.local/lib/node_modules/openclaw/node_modules/.bin/tsc -p tsconfig.json --noEmit` passed.

2026-05-10 Job T:

- Backup available before this tranche: `backups/openclaw-agent-mesh-gateway-20260510T1745UTC.tar.gz`.
- Added injectable controlled Discord sender boundary, local `openclaw.agent.discord_send_attempt.v1` records, and `discord-send-attempts.ndjson` store support.
- Fake-sender tests prove the sender is called exactly once only for the approved/configured case and never for disabled, deny, ask-human, secret, unconfigured, paused, or kill-switch-blocked cases.
- `npm test` passed: 14 test files, 14 pass, 0 fail.
- `/root/.local/lib/node_modules/openclaw/node_modules/.bin/tsc -p tsconfig.json --noEmit` passed.
- No OpenClaw core/runtime config changes, no CAS calls, and no real Discord/OpenClaw message sends were performed.

2026-05-10 Job U:

- Backup available before this tranche: `backups/openclaw-agent-mesh-gateway-20260510T1751UTC.tar.gz`.
- Final demo command:

```bash
node --import ./test/ts-extension-resolver.mjs -e 'import("./src/demo/demo-phase2-policy.ts").then(async (m) => console.log(JSON.stringify(await m.buildPhase2PolicyCompletionDemo(), null, 2)))'
```

- Demo status: deterministic JSON includes unified policy decisions for memory, proactivity, model selection, CAS plan/dispatch, and Discord plan/send; CAS and Discord paths use injected fake dispatcher/sender only and report call counts.
- Guardrails preserved: no OpenClaw core/runtime config changes, no direct OpenClaw message tool calls, no direct `codex_workers` calls, no mem0/wiki/folder writes, no cron/tool side effects, no real CAS, and no real Discord send.

2026-05-10 Job V:

- Backup available before this tranche: `backups/openclaw-agent-mesh-gateway-20260510T1829UTC.tar.gz`.
- Added `CasHostBindingFacade`, `HostCasInvocationFunction`, and strict host request/safety types.
- Tests use a fake host invoker only: approved `/tmp` smoke dispatch calls once, non-`/tmp` is rejected by default, prompt guardrails are present, and host failures surface through the dispatcher error path.
- Guardrails preserved: no OpenClaw tool imports/calls, no `codex_workers_run_task`, no push/publish/deploy/restart/delete, and no non-temp workspace dispatch unless explicitly allowed by caller options.

## Guardrails

- The legacy mesh Codex runner remains record-only; controlled real CAS dispatch is available only through the injected `StrictCasRunnerDispatchAdapter` boundary.
- Controlled Discord delivery is available only through the injected `ControlledDiscordAdapter` sender boundary.
- Do not bind injected boundaries to real OpenClaw tools, `codex_workers_run_task`, CAS/Codex workers, or Discord/message sends without an explicit rollout approval and a narrow allow-once smoke plan.
- Do not perform push, publish, deploy, restart, delete, or OpenClaw core/runtime config changes without explicit approval.
- Keep project checklists and update logs current on every substantive plan or implementation change.
