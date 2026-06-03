# Agent Mesh OpenClaw Plugin

OpenClaw adapter package for Agent Mesh planning tools.

This package wires the runtime-agnostic core into OpenClaw plugin tools. It is intentionally thin: real deployment-specific participants, channel ids, guild ids, paths, and feature flags should live in private host configuration, not in this package.

## Scripts

```bash
npm run build
```

## Example Config

See `examples/openclaw.config.example.jsonc`.

