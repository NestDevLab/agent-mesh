# Agent Mesh OpenClaw Plugin

OpenClaw adapter package for Agent Mesh planning tools.

This package wires the runtime-agnostic core into OpenClaw plugin tools. It is intentionally thin: real deployment-specific participants, channel ids, guild ids, paths, and feature flags should live in private host configuration, not in this package.

## Current boundary

Implemented here:

- OpenClaw plugin registration as `agent-mesh-wrapper`.
- Dry-run planning tools for runtime actions, Discord bridge turns, event-task turns, and Mesh v1 pre-dispatch handling.
- Audit JSONL writes for tool invocations when audit is enabled.
- Generic, config-driven OpenClaw example config.

Not implemented here yet:

- A live inbound Discord interception hook before OpenClaw agent dispatch.
- Durable cross-message partial/final state persistence owned by OpenClaw runtime hooks.
- Automatic pre-dispatch rewrite/injection of assembled Mesh v1 content.
- Live send/forward side effects from the plugin itself.

Until those hooks are wired, treat this package as the safe OpenClaw planning/adapter layer, not as the full live runtime path.

## Mesh v1 finality rule

Complete peer handoffs must use `final=1` in compact `ccm:v1` envelopes. Use `final=0` only for partial context chunks that should be buffered and must not dispatch the receiving agent yet.

The runtime-neutral hydrator defaults compact messages to `final=1`; pass `--final 0` only when deliberately sending a partial chunk:

```bash
node ../../scripts/mesh-hydrate.mjs \
  --compact \
  --to next-peer \
  --from current-peer \
  --id smoke-run \
  --body "Complete handoff body."
```

## Scripts

```bash
npm run build
```

## Example Config

See `examples/openclaw.config.example.jsonc`.

