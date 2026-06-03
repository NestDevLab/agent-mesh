# Agent Mesh

Current status: **v0.9 preview**. This repository is ready for serious controlled live testing, not yet a v1.0 stability release.

Agent Mesh is a consolidated monorepo for bounded multi-agent workflows around OpenClaw/Hermes-style agent teams.

It merges the previously separate policy/plugin package, Discord gateway sidecar prototype, and runtime wrapper integration into one testable tree.

## Packages

- `@openclaw-agent-mesh/core` — runtime-agnostic policy, task-turn, run-scope, phase, and replay-control primitives.
- `@openclaw-agent-mesh/openclaw-plugin` — OpenClaw plugin adapter exposing planning tools backed by the core package.
- `@openclaw-agent-mesh/gateway` — controlled Discord gateway sidecar with policy decisions, proactivity, model selection, and host binding facades.
- `@openclaw-agent-mesh/runtime-wrapper` — OpenClaw runtime wrapper/plugin integration for sidecar rollout and dry-run safety.

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
- `docs/karan-hermes-source-notes.md`

## Development

```bash
npm ci
npm run verify
```

`npm run verify` runs build, tests, local Mesh harness smoke, and readiness privacy checks.

Useful Mesh commands:

```bash
npm run mesh:smoke
npm run mesh:readiness
npm run mesh:harness -- --participant karan --state-file /tmp/agent-mesh-state.json --pretty
```

See `docs/mesh-v0.9-live-testing.md` before any live Discord test.
