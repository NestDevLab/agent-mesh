# OpenClaw Agent Mesh Gateway

Phase 1 implementation slice for a sidecar Agent Mesh gateway.

This package is intentionally separate from OpenClaw core. It currently covers envelope validation, context and agent registries, gateway routing, delivery lifecycle, append-only audit/storage replay, Discord transcript mapping stubs, a governed Codex runner stub, and injectable Discord runtime boundaries.

The tmux transport can optionally use an injected Limen admission broker. Capacity-deferred work is
persisted with an explicit `waiting_capacity` status and exact `retryAt`; the host calls the bounded
drain method to resume due work. The adapter does not sleep, inspect a spinner, reinject a prompt, or
kill work already delivered. Routes declare L1/L2/L3; omission inside a capacity policy means L1.

It is also intentionally separate from `openclaw-federation-bridge`. The federation bridge is a request routing and policy boundary between OpenClaw instances or bridge peers. This package is the higher-level orchestration mesh: it coordinates logical agents and records how their messages map onto bridge-style request, correlation, reply-parent, idempotency, policy, and adapter concepts.

## Scope

Phase 1 is stub-first:

- no real Discord writes;
- no external tool execution;
- no memory commits;
- no OpenClaw core changes;
- no service restarts or deployment behavior.

Implemented safety guards include persisted pause/kill-switch state, startup recovery audit events, gateway-computed canonical content hashes for anti-loop checks, idempotency conflict detection, and minimal secret-persistence rejection for unredacted `secret` envelopes or obvious secret-shaped payload fields.

Phase 1 also rejects unknown or inactive domains, unknown sender/recipient agents, agents not enabled for the target context, unapproved `from === to` messages, and agent-only attempts to reopen terminal conversations/tasks. The terminal reopen guard is intentionally narrow: it only acts on explicit metadata flags (`agent_only` plus `reopens_terminal_conversation` or `reopens_terminal_task`) unless `allow_terminal_reopen` is also explicit.

Discord runtime binding is host-owned. The package provides `OpenClawHostMessageSender`, a facade that adapts the existing `DiscordMessageSender` interface to an injected host function shaped like OpenClaw `message/send`. It translates mesh Discord send requests into strict dry-run host requests with `channel: "discord"`, deterministic channel/thread targets, content, idempotency key, and smoke metadata. It does not import or call the OpenClaw message tool, and real sends are rejected unless the facade is explicitly constructed with real-send allowance.

Phase 2 model/reasoning policy is documented in `docs/model-reasoning-policy.md`, including role-aware profile selection for advisory policy.

Current architecture direction: do not introduce a central memory broker by default. Use a Memory Fabric instead: cross-host prompt/artifact/synced-folder handoffs, same-host local-folder and mem0 sharing through OpenClaw config, and gateway-enforced mem0 scopes per logical agent/team/domain. The Phase 2 policy design is documented in `docs/memory-fabric-policy.md`.

Proactivity is part of the product shape, not just scheduling. Every proactive agent should include a self-improvement loop: inspect outcomes, keep domain checklists/playbooks current, tune methods, improve handoffs, and avoid stale unresolved work. The Project Manager backlog loop is only one example. The Phase 2 engine design is documented in `docs/proactivity-engine.md`.

Phase 2 starts a package-local Guardian approval facade. It records a structured approval request and decision for governed execution jobs using Guardian-shaped concepts: policy profile, reviewer flow, `allow-once`, `deny`, and `ask-human`. This is local and stubbed: no Guardian broker process is called, no approval is resolved upstream, and no external execution is attempted.

Accepted envelope audit events include package-local bridge-alignment details. These are descriptive and stub-safe; they do not call the production federation bridge or perform external delivery.

## Layout

```text
config/   Initial context and logical agent records
docs/     Phase 1 architecture, bridge alignment, Memory Fabric policy, Proactivity Engine, model/reasoning policy, real-adapter boundaries, policy roadmap, and sidecar rollout notes
src/      Schema, core, adapters, persistence, and demos
test/     Node test coverage for validation, persistence, and gateway behavior
```

## Scripts

```bash
npm run typecheck
npm run build
npm test
```

Do not install dependencies unless explicitly assigned. If TypeScript is not available locally, report that as a setup blocker.

## Rollout Status

The selected safe rollout path is sidecar-first. The package remains separate from OpenClaw core and exposes governed facades for host-owned Discord calls. See `docs/rollout-sidecar.md` for the final rollout notes, allow-once smoke policy, and 2026-05-11 real smoke evidence.

## Phase 1 Demo And Verification

Request/reply stub demo command:

```bash
node --import ./test/ts-extension-resolver.mjs -e 'import("./src/demo/demo-request-reply.ts").then(async (m) => console.log(JSON.stringify(await m.runRequestReplyDemo(), null, 2)))'
```

Representative output:

```json
{
  "request_duplicate": false,
  "reply_duplicate": false,
  "request_deliveries": [
    ["simulated-agent", "delivered"],
    ["discord-transcript-stub", "stubbed"]
  ],
  "reply_deliveries": [
    ["simulated-agent", "delivered"],
    ["discord-transcript-stub", "stubbed"]
  ]
}
```

Codex execution-job stub demo command:

```bash
node --import ./test/ts-extension-resolver.mjs -e 'import("./src/demo/demo-codex-job.ts").then(async (m) => console.log(JSON.stringify(await m.runCodexJobDemo(), null, 2)))'
```

Representative output:

```json
{
  "duplicate": false,
  "deliveries": [
    ["discord-transcript-stub", "stubbed"],
    ["codex-runner-stub", "stubbed"]
  ]
}
```

Phase 2 policy/demo command:

```bash
node --import ./test/ts-extension-resolver.mjs -e 'import("./src/demo/demo-phase2-policy.ts").then((m) => console.log(JSON.stringify(m.buildPhase2PolicyDemo(), null, 2)))'
```

It returns deterministic local-only decisions for Memory Fabric, stale backlog proactivity, and model selection with all real-adapter guardrails still enabled.

Phase 2/3 policy completion demo command:

```bash
node --import ./test/ts-extension-resolver.mjs -e 'import("./src/demo/demo-phase2-policy.ts").then(async (m) => console.log(JSON.stringify(await m.buildPhase2PolicyCompletionDemo(), null, 2)))'
```

It returns deterministic local-only JSON with common `openclaw.agent.policy_decision.v1` records for Memory Fabric, Proactivity, model selection, and Discord delivery/send planning. Discord send uses injected fake sender boundaries only; no direct OpenClaw message tool, real Discord, memory, cron, or runtime-config side effect is performed.

Runtime host-binding smoke command:

```bash
node --import ./test/ts-extension-resolver.mjs -e 'import("./src/demo/runtime-host-binding-smoke.ts").then(async (m) => console.log(JSON.stringify(await m.buildRuntimeHostBindingSmokeDemo(), null, 2)))'
```

It returns deterministic dry-run JSON containing a sample Discord host message request built through `OpenClawHostMessageSender` / `toHostMessageSendRequest`. The demo uses injected fake host functions only and reports `no_core_config_change`, `no_direct_tool_calls`, `dry_run`, and `real_send_enabled: false`.

Verification run recorded on 2026-05-11 after authorized real smoke tests:

```text
$ npm test -- --test-reporter=dot
# tests 99
# pass 99
# fail 0

$ ./node_modules/.bin/tsc -p tsconfig.json --noEmit
# pass
```

Authorized real smoke evidence:

- Discord smoke: one visible message in approved thread/channel `DISCORD_ID_PLACEHOLDER`, message id `DISCORD_ID_PLACEHOLDER`, no channel/thread mutation.
