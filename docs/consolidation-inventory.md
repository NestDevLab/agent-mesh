# Agent Mesh Consolidation Inventory

This branch consolidates the surviving Agent Mesh implementations into one monorepo.

## Canonical target

Intended canonical path:

```text
/path/to/workspace/nestdevlabs/agent-mesh
```

Current blocker: that directory exists but is owned by `nobody:nogroup` with `0755`, and both local `administrator` and `root@nestdev` hit `Operation not permitted` on `chown`. Until the mount/ownership is fixed, this working branch is assembled at:

```text
/path/to/workspace/openclaw/shared/projects/agent-mesh-consolidation
```

## Sources merged

### Existing package repo

Source:

```text
/path/to/workspace/openclaw/openclaw-agent-mesh
```

Remote recorded there:

```text
https://github.com/NestDevLab/openclaw-agent-mesh.git
```

Imported as base:

- `packages/core/`
- `packages/openclaw-plugin/`
- root package metadata and docs

The source tree had local modifications in:

- `packages/core/src/policy.js`
- `packages/openclaw-plugin/openclaw.plugin.json`

Those modifications are preserved in this consolidation branch.

### Legacy gateway sidecar implementation

Source:

```text
/path/to/workspace/openclaw/archive/agent-mesh-legacy-20260530T215439Z
```

Imported cleanly, excluding generated/runtime artifacts (`node_modules`, `dist`, `var`, build info):

- `openclaw-agent-mesh-gateway/` → `packages/gateway/`
- `openclaw-agent-mesh-wrapper/` → `packages/runtime-wrapper/`

Not imported into final package layout:

- generated `dist/`
- runtime `var/agent-mesh/`
- dependency folders

### Karan/Hermes/OpenClaw operational trail

Relevant trail is preserved by reference, not raw-imported into the repo, because it contains session transcripts and private operational context.

Pointers:

```text
/home/administrator/.openclaw/agents/karan-nestdev/sessions/agent-mesh-taboo-round-2-nestdev.jsonl
/home/administrator/.openclaw/agents/karan-nestdev/sessions/agent-mesh-taboo-round-2-nestdev.trajectory.jsonl
/home/administrator/.openclaw/agents/karan-nestdev/sessions/agent-mesh-taboo-round-2-nestdev.trajectory-path.json
/path/to/workspace/openclaw/runtime/agent-mesh-wrapper
```

The repo keeps the reusable code/artifacts, not private raw session dumps.

## Final package layout

```text
packages/core/              Runtime-agnostic policy primitives
packages/openclaw-plugin/   OpenClaw plugin adapter from existing package repo
packages/gateway/           Discord gateway sidecar implementation
packages/runtime-wrapper/   Runtime wrapper/plugin integration
```

## Verification policy

Before pushing this branch:

```bash
npm install
npm run build
npm test
```

If dependency installation or GitHub push is blocked by missing credentials/network, keep the local branch and report the blocker explicitly.
