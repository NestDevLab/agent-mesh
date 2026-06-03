# runtime-a/runtime-b Source Notes

runtime-a/runtime-b contributed operational validation and routing work around Agent Mesh, especially the Discord Taboo mesh tests and local/direct participant routing checks.

Raw session files are intentionally **not** committed into this repo by default. They may include private Discord context, prompts, tool traces, and operational host details. Keep them as source references and extract only reusable code, tests, or docs.

## Source references

```text
/home/operator/.openclaw/agents/runtime-a-nestdev/sessions/agent-mesh-taboo-round-2-nestdev.jsonl
/home/operator/.openclaw/agents/runtime-a-nestdev/sessions/agent-mesh-taboo-round-2-nestdev.trajectory.jsonl
/home/operator/.openclaw/agents/runtime-a-nestdev/sessions/agent-mesh-taboo-round-2-nestdev.trajectory-path.json
/path/to/workspace/openclaw/runtime/agent-mesh-wrapper
```

## Durable implementation points to preserve

- Direct local OpenClaw participant routing for managed participants.
- Federation bridge route for external OpenClaw gateways where exposed.
- Discord mention fallback only for unmanaged or not-yet-routable participants.
- Reply/thread linkage and visible-state minimization: natural public messages first; machine state in runtime metadata where possible.
- Safety defaults: dry-run, allow-once gates, no direct Discord/CAS side effects without explicit host-provided adapters and approval.

## Privacy rule

If a later pass needs to import transcript-derived material, extract the smallest useful artifact into docs/tests/code and cite the source path. Do not bulk-commit raw session JSONL.
