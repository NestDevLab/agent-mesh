# Consolidation Inventory

This repository contains only reusable, runtime-neutral Agent Mesh code, tests, and public documentation.

## Included

- `packages/core/` — runtime-agnostic policy, envelope, turn, and replay primitives.
- `packages/gateway/` — controlled gateway sidecar and transport boundary prototypes.
- `packages/runtime-wrapper/` — generic runtime-wrapper integration patterns and tests.
- `packages/tmux-bridge/` — tmux transport utilities.
- `docs/` — public protocol, transport, architecture, readiness, and release notes.

## Excluded

The following are intentionally not stored in this public repository:

- private deployment paths or hostnames;
- real Discord guild/channel/thread/user/message IDs;
- session transcripts, trajectory files, or raw operational logs;
- private agent names, domain names, customer/project topology, or participant registries;
- secrets, tokens, local runtime state, approvals, or live rollout reports.

## Import rule

When consolidating work from another environment, extract only reusable code, public docs, synthetic fixtures, and tests. Keep operational evidence in the private ops repository and reference it only as sanitized behavior, never as raw paths or transcripts.
