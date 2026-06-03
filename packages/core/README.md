# Agent Mesh Core

Runtime-agnostic policy and controller primitives for bounded multi-agent workflows.

The core package does not know about OpenClaw, Discord, Slack, Telegram, local paths, hostnames, or real users. Hosts provide configuration, state, audit sinks, and transport adapters.

Current primitives include:

- runtime action planning guardrails;
- Discord-style bridge turn validation;
- event-task turn planning;
- explicit run id requirements;
- run-scoped state propagation;
- completed-run replay suppression;
- participant allowlists;
- task phase gating;
- deterministic tests for controller behavior.

## Scripts

```bash
npm run build
npm test
```

