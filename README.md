# Agent Mesh

Current status: **v0.9 preview**. This repository is ready for serious controlled live testing, not yet a v1.0 stability release.

Agent Mesh is a consolidated monorepo for bounded multi-agent workflows around runtime-adapter agent teams.

It merges the previously separate policy/plugin package, Discord gateway sidecar prototype, and runtime wrapper integration into one testable tree.

## Packages

- `@openclaw-agent-mesh/core` — runtime-agnostic policy, task-turn, run-scope, phase, and replay-control primitives.
- `@openclaw-agent-mesh/openclaw-plugin` — OpenClaw plugin adapter exposing planning tools backed by the core package.
- `@openclaw-agent-mesh/gateway` — controlled Discord gateway sidecar with policy decisions, proactivity, model selection, and host binding facades.
- `@openclaw-agent-mesh/runtime-wrapper` — OpenClaw runtime wrapper/plugin integration for sidecar rollout and dry-run safety.
- `@openclaw-agent-mesh/tmux-bridge` — agnostic tmux bridge for CLI-to-CLI agent intercommunication, surfaced in the gateway as the `tmux-transport` adapter (a peer of the Discord adapter). See `docs/transports.md`.

## AgentWheel / OpenPack install

This repo is an OpenPack package for AgentWheel. `openpack.json` is the
canonical package manifest; the older `agentwheel.json` manifest is not used.

Install the shared runtime-neutral instructions and tmux skills:

```bash
npm i -g agentwheel
agentwheel registry update
agentwheel add nestdev-mesh --adapter codex
agentwheel install --dry-run
agentwheel install
```

OpenClaw runtimes that need the optional mesh plugin should select it
explicitly instead of installing it everywhere:

```bash
agentwheel install nestdev-mesh \
  --adapter openclaw \
  --select plugins/openclaw-agent-mesh \
  --dry-run

# after reviewing the plan:
agentwheel install nestdev-mesh \
  --adapter openclaw \
  --select plugins/openclaw-agent-mesh
```

The package provides the `claude-tmux` and `codex-tmux` skills from `skills/`.
With AgentWheel asset-includes, each installed skill also receives the bridge
scripts and agent configs it needs under its own `bin/` and `agents/`
directories. The canonical script source remains `packages/tmux-bridge/bin` in
this repo; no generated script copies are committed.

When Codex Desktop exposes native task tools, Codex-to-Codex coordination uses
those tools before tmux: create or fork user-visible tasks natively, message an
existing task directly, and observe it through thread reads or waits. The tmux
bridge remains the path for persistent CLI sessions, cross-runtime work,
on-disk recovery, explicit tmux requests, and native-unavailable fallback. See
`docs/transports.md` for the capability-gated routing rule.

Repository mode remains supported by setting `AGENT_MESH_ROOT` and using
`$AGENT_MESH_ROOT/packages/tmux-bridge/bin` directly.

## Design rules

- Core code must stay runtime-agnostic: no real Discord ids, host paths, bot names, secrets, or private deployment assumptions.
- Runtime integrations must load participants, targets, tasks, and allowlists from configuration.
- Bot and worker output is untrusted input.
- Real external side effects remain gated by host policy and explicit approval.
- Every bounded live run should carry an explicit run or orchestration id.
- Keep generated output, runtime state, session transcripts, and private raw logs out of the repo.

## Consolidation notes

See:

- `docs/consolidation-inventory.md`
- `docs/agent-beta-runtime-source-notes.md`

## Development

```bash
npm ci
npm run verify
```

`npm run verify` runs build, tests, local Mesh harness smoke, and readiness privacy checks.

Useful Mesh commands:

```bash
npm run mesh:smoke
npm run mesh:decentralized
npm run mesh:readiness
npm run mesh:harness -- --participant agent-beta --state-file /tmp/agent-mesh-state.json --pretty
```

## Mesh v1 compact Discord header

Preferred live Discord shape:

```text
<@bot>
ccm:v1 id=live-peer-20260603-a from=agent-beta turn=nestdev final=1 seen=runtime,agent-beta hop=3

body...
```

The legacy multi-line `cc-mesh-*` headers are still accepted for compatibility. In the compact form, `turn` is also treated as the single recipient unless an explicit `to=` field is present.

See `docs/mesh-v0.9-live-testing.md` before any live Discord test.
