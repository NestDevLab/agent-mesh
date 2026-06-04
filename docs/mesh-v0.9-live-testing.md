# Mesh v0.9 Live Testing Plan

Status: **v0.9 preview**, not v1.0.

v0.9 is intended for serious live testing in controlled Discord/OpenClaw/Hermes surfaces. v1.0 should wait until the protocol has been used live for a while and has shown stable behavior.

This plan is Discord-only: it tests message ingestion, Mesh headers, pre-wake gating, state persistence, dedupe, and loop guards. It does not include execution backends.

## What v0.9 guarantees locally

- Mesh v1 envelope parsing is runtime-neutral.
- Ambiguous or malformed headers fail closed.
- Partial chunks are buffered only and must not wake an agent.
- Final chunks assemble buffered context and produce one `dispatch_once`.
- Duplicate finals are suppressed after dispatch.
- `cc-mesh-turn` gates the local participant.
- `cc-mesh-seen` and `hop-limit` guard loops.
- The public tree is scanned for private IDs, host paths, and secret-shaped literals by `npm run mesh:readiness`.

## Commands before any live test

```bash
npm ci
npm run verify
```

`npm run verify` includes build, tests, the local mesh harness smoke, and readiness privacy checks.

## Local live-harness rehearsal

Use the side-effect-free harness before touching Discord:

```bash
cat fixtures.txt | npm run mesh:harness -- --participant karan --state-file /tmp/agent-mesh-state.json --pretty
```

Separate multiple candidate Discord messages with a line containing exactly:

```text
---mesh-message---
```

Only `nextAction=dispatch_once` may wake the runtime. `buffer_only`, `none`, and invalid-envelope results must not wake an agent.

## Required live matrix

Run these in a disposable test thread with placeholder participants, no production channel IDs in the repo, and a single explicit run id.

Legacy header form:

1. Partial chunk only
   - Send `cc-mesh-final: false`.
   - Expected: no wake-up, state persisted.
2. Partial then final
   - Send same `cc-mesh-id`, then `cc-mesh-final: true`.
   - Expected: exactly one wake-up with assembled context.
3. Duplicate final replay
   - Re-send the final message.
   - Expected: no wake-up.
4. Out-of-turn message
   - Use a different `cc-mesh-turn`.
   - Expected: fail closed.
5. Seen loop guard
   - Include the local participant in `cc-mesh-seen`.
   - Expected: fail closed.
6. Hop exhaustion
   - Use `hop-limit: 0`.
   - Expected: fail closed.

Compact `ccm:v1` form:

- Complete peer handoffs use `final=1`.
- Partial context chunks use `final=0` and must not dispatch.
- `turn=<local-participant>` is the current-turn gate; when `to=` is omitted, `turn=` is also the recipient list.
- Real Discord mentions still wake the bot; the compact header only tells the Mesh planner whether to dispatch, buffer, or drop after wake.

## Sanitized live smoke note

A complete three-peer Discord smoke has passed with raw Discord mentions plus compact `ccm:v1` headers across this shape:

```text
alpha -> beta -> gamma -> observer
```

Observed result: the observer received a final acknowledgement marker and the round closed without code/config/deploy changes. The important regression note from that run is finality discipline: a peer-to-peer handoff that contains a complete message should emit `final=1`; reserve `final=0` for deliberate partials only.

Do not store live thread ids, Discord user ids, or raw transcripts in this public repo. Keep live evidence in private ops notes and keep this document as the sanitized protocol/runbook memory.

## Runtime adapter contract

A live adapter must do exactly this around the core planner:

1. Load persisted Mesh v1 state for the runtime participant.
2. Call `agent_mesh_plan_mesh_v1_dispatch` or `planMeshV1Dispatch`.
3. Persist `stateTransition` when present before any wake-up.
4. Wake the agent only when `nextAction === "dispatch_once"`.
5. Pass only `dispatchText` as assembled task context.
6. Never wake on partial, duplicate, invalid, out-of-turn, seen, or exhausted-hop results.
7. Append the local participant to `cc-mesh-seen` before forwarding to another participant.
8. Emit audit metadata for `reason`, `meshId`, `from`, `turn`, and `nextAction`, but never persist private raw secrets.

## v1.0 exit criteria

Do not call this v1.0 until:

- the required live matrix passes more than once;
- at least one real multi-agent workflow runs for a while without duplicate wakes;
- loop guard behavior is observed live;
- recovery after restart preserves dedupe state;
- CI remains green;
- no private config or Discord IDs are needed in this public repository.
