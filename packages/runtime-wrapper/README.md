# OpenClaw Agent Mesh Wrapper

Private wrapper scaffold for the Agent Mesh sidecar.

Default mode is `observe`: it can plan and audit runtime actions, but it does not execute CAS dispatches or Discord sends.

In the current private-customizations runtime integration, audit records resolve relative to the gateway process working directory and have been verified at `/root/runtime/agent-mesh-wrapper/audit.jsonl`.

## Guardrails

- no OpenClaw core changes;
- no config mutation by this package;
- no deploy/restart/push/publish behavior;
- dry-run by default;
- kill-switch and pause flags;
- explicit Discord target allowlist;
- explicit CAS temp/repo allowlist;
- controller-mediated Discord bridge planner for unmanaged/external bots;
- real sends/dispatches require `mode: "enforce"` plus explicit real-action flags and a higher-level allow-once approval;
- `plan` mode remains dry-run and supports both top-level payloads and nested `request` payloads used by runtime smoke calls.

## Controller-mediated bridge planner

`agent_mesh_plan_discord_bridge_turn` validates one Discord handoff without forwarding anything.

It enforces the Agent Dialogue rules used for unmanaged/external bots:

- one expected speaker;
- source bot must be participant-allowlisted;
- channel/thread target must be allowlisted;
- compact `ORCH` / `TURN` / `NEXT` / `STATE` footer is parsed and validated;
- body+footer split across adjacent messages can be normalized as one logical turn via `request.messages`;
- `NEXT` may use an exact mention/id or an explicitly allowlisted participant label (normalized to the configured mention);
- `STATE: done` and `STATE: paused` must not tag a next bot;
- handoff turns must stay within `bridge.maxTurns`;
- output is dry-run only and never authorizes real CAS/Discord side effects.

## Scripts

```bash
npm run build
npm test
```

## Example config

See `examples/openclaw.config.example.jsonc`.
