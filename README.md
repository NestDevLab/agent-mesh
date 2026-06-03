# Agent Mesh

Agent Mesh is a consolidated monorepo for bounded multi-agent workflows around OpenClaw/runtime-b-style agent teams.

It merges the previously separate policy/plugin package, the Claude/CAS gateway sidecar prototype, and the runtime wrapper integration into one testable tree.

## Packages

- `@openclaw-agent-mesh/core` — runtime-agnostic policy, task-turn, run-scope, phase, and replay-control primitives.
- `@openclaw-agent-mesh/openclaw-plugin` — OpenClaw plugin adapter exposing planning tools backed by the core package.
- `@openclaw-agent-mesh/gateway` — controlled gateway sidecar with CAS dispatch boundary, Discord boundary, policy decisions, proactivity, model selection, and host binding facades.
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
- `docs/runtime-a-runtime-b-source-notes.md`

## Development

```bash
npm install
npm run build
npm test
```

Or run the combined verifier:

```bash
npm run verify
```
