# What Discord-connected agents need to know about the tmux transport

Read this if you are a Discord-connected agent operating in the mesh. A new sibling
transport (tmux) has been added. This note tells you exactly what changes for you.

## TL;DR

**Nothing in your Discord flow changes.** Channel naming, `update-channel.sh`,
`send-to-discord.sh`, embeds, pings, approval gates, and idempotency all behave
exactly as before. A new sibling transport (tmux) now exists for CLI-to-CLI agent
communication, behind the *same* adapter interface you already rely on. You do not
need to change your operating model. Keep working as you do today.

## What stayed the same

Your Discord behavior is untouched. Specifically, all of these are unchanged:

- **Channel naming** — still `{project}-{task}` in kebab-case, max 5 words.
- **`update-channel.sh`** — same script, same arguments, same usage.
- **`send-to-discord.sh`** — same messages, files, and rich embeds (title +
  description, named colors).
- **Embeds and pings** — same format, same `@username` ping semantics, same color
  names.
- **Approval gates** — human approval is still required for the same sensitive /
  external-facing actions; the dry-run-first posture is unchanged.
- **Idempotency** — outbound messages still dedup by `idempotency_key` the same
  way.

No Discord code was modified to add the tmux transport. The tmux work added a new
adapter alongside Discord; it did not edit, wrap, or reroute the Discord path.

## What is new

There is now a second transport, **tmux**, for **CLI-to-CLI (agent-to-agent)**
communication — one agent dispatching a prompt to another agent's tmux session
(Codex, Claude Code, Gemini, …), backed by the `@openclaw-agent-mesh/tmux-bridge`
scripts. It is a *peer* of the Discord adapter, not a replacement and not a layer
above or below it.

Both transports implement the identical mesh interface:

```ts
dispatch(delivery, envelope) -> AdapterDispatchResult
```

So the system can route a delivery to Discord, to tmux, or run both, with no change
to either adapter.

### When each transport is used

- **Discord** = the human-facing command, transcript, and approval surface. Use it
  for status updates, approval requests, transcripts, and anything a person needs
  to see or steer. This is still your surface.
- **Tmux** = agent-to-agent direct collaboration between CLI agents, with no
  human-facing channel in the loop.

Picking a transport changes only the *destination*. The protocol and the
guarantees are the same.

## Shared invariants you can rely on (across both transports)

Because tmux sits behind the same interface and the same coordination core, any
message that crosses transports still honors the invariants you already trust:

- **Same envelope schema** — `AgentMessageEnvelopeV1` for both. Same
  `message_id`, `intent`, `from`/`to`, `content`, correlation fields.
- **Same anti-loop** — `evaluateAntiLoop` (TTL, expiry, self-message, ping-pong)
  runs before any send on both transports.
- **Same dry-run-first** — real sends are off by default everywhere. Tmux is
  stubbed unless a route sets `enable_real_send: true`; Discord still requires
  explicit real-send enablement plus approval.
- **Same idempotency** — dedup by `idempotency_key`; a prior non-failed delivery
  suppresses re-send on both transports.
- **Same sensitivity / redaction policy** — classification and redaction apply
  before any real outbound send, regardless of transport.
- **Correlation IDs preserved across transports** — `trace_id`,
  `correlation_id`, and `causation_id` are carried through delivery and audit on
  both paths, so a conversation that touches tmux and Discord stays linked under
  the same correlation semantics (see
  `packages/gateway/docs/bridge-alignment.md`).

Each transport also keeps its own append-only audit trail (Discord delivery/audit
records; `tmux-dispatch-events.ndjson` for tmux), so cross-transport activity
remains traceable.

## What you must NOT assume any more

Nothing breaks, and here is the precise reason why: the tmux transport was added as
a peer behind the **same** `MeshTransportAdapter` interface, reusing the **same**
envelope, anti-loop, idempotency, dry-run gate, and audit patterns. It added no
Discord changes. So:

- You do **not** need to detect, branch on, or special-case the transport. Treat a
  mesh message the same way regardless of which transport carried it — the envelope
  and its guarantees are identical.
- You do **not** need new approval logic. The same gates apply on both paths.
- You do **not** lose correlation when a thread spans transports. The correlation
  IDs are preserved end to end.
- You should **not** assume tmux is a back channel that bypasses safety. It honors
  the same dry-run-first, idempotency, anti-loop, and sensitivity invariants you
  rely on.
- You should **not** assume tmux auto-starts or discovers sessions. It only
  dispatches to explicitly configured routes against existing tmux targets; session
  lifecycle is out of band.

In short: there is no Discord behavior to relearn and no assumption you must drop.
The only new fact is that a peer transport exists. If you are a Discord-connected
agent reading this cold, keep operating exactly as you do today.

## Where to read more

- Transport overview and comparison — `docs/transports.md`
- Tmux adapter boundary — `packages/gateway/docs/tmux-adapter-boundary.md`
- Tmux adapter contract (source of truth) —
  `packages/gateway/docs/tmux-adapter-contract.md`
- Discord adapter boundary —
  `packages/gateway/docs/discord-adapter-boundary.md`
- Correlation / bridge semantics —
  `packages/gateway/docs/bridge-alignment.md`
- tmux-bridge scripts — `packages/tmux-bridge/README.md`
