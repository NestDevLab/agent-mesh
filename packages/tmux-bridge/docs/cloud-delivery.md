# Claude cloud queue delivery

The native transport supports a single follow-up to an existing Claude cloud session:

```sh
agent-native-call --agent claude --cloud --delivery-only \
  --session session_Example123 --correlation-id request-example \
  --message 'Synthetic follow-up'
```

Use an exact `session_` or `cse_` identifier. Descriptions, URLs and local UUIDs are
rejected in cloud mode, preventing accidental cloud-session creation. Cloud mode
requires `--delivery-only` and forbids native resume and managed local inboxes.
It neither discovers recipients nor grants a role based on a title or opaque graph
reference. The caller must independently verify the intended recipient.

The transport invokes the [official Claude cloud follow-up CLI](https://code.claude.com/docs/en/claude-code-on-the-web#send-follow-ups-from-the-cli)
with JSON output, sends the message on stdin, and accepts only exit zero with
`ok: true` and the exact requested `session_id`. It needs the CLI's existing
account configuration; it does not change authentication or permission settings.
No local transcript is required. The optional `CLAUDE_BIN` selects the CLI executable.

The existing Claude communications gate owns durable admission, FIFO ordering,
expiry, correlation/payload deduplication, serialized sends, and capability-bound
queue replay. Held cloud records retain their transport discriminator during replay.
An off gate rejects before invoking the provider. Preserve the same correlation
when observing an uncertain operation; never invent a new correlation to retry it.

A successful result has `status: "queued"`, `transport: "claude-cloud"`,
`readBack: false`, and `responseObserved: false`. It proves provider acceptance only.
The comms store's legacy `delivered` status also means transport acceptance, not
transcript observation or human reading. A repeated accepted correlation returns
the existing gate receipt without sending again. Changed content with the same
correlation is rejected. Timeout, nonzero exit, malformed output or mismatched
session identity retain an unknown receipt and cannot be automatically resent.
Even a provider error is treated conservatively as uncertain after invocation.

This is outbound queue delivery only. It does not collect a cloud response, create
a bidirectional session link, install a relay, poll sessions, or configure a return
route. Verify any response separately with a matching correlation and trustworthy
sender evidence. A cloud sender may use an existing authorized MCP session ingress
for a local recipient; its actual principal and session scope must be checked first.

## Register a cloud session in the local graph

After independently confirming the provider account and the exact session under
that account, a local operator can record the identity:

```sh
mesh-graph cloud register --session claude-cloud:team-a:session_Example123 \
  --evidence operator:verified-session-record
mesh-graph cloud get --session claude-cloud:team-a:session_Example123
```

Choose a stable, distinct lowercase account scope for each provider account or
tenant; it is an operator-assigned namespace, not a credential. Keep the provider
ID exactly as verified, including case. Do not treat a `session_` ID and a `cse_`
ID as aliases. Use an opaque reference to the verification record and keep
credentials and evidence contents out of graph state.

The graph records an operator attestation, not a provider authentication check.
The registered ID identifies a graph session; it gives no delivery, live activity,
local writer, singleton role, or sender authority. Cloud registrations stay in
the local graph and are excluded from scoped gateway queries. Local session IDs
remain `codex:<uuid>` and `claude:<uuid>`.

A local group manager can add the registered ID with
`agent-mesh group add <group-id> claude-cloud:team-a:session_Example123`.
The command checks that the exact registration is open in the default local
graph. Membership is durable; closing the graph registration blocks future adds
without removing existing members. A group member ID is not a credential. The
local CLI rejects cloud IDs in `--as-session`; an authenticated adapter would
need to bind the actual provider principal to a session separately before it
could read or append group messages.

## Correlated return through the existing Codex transport

A local relay can return a cloud recipient's response through the same native
communications gate, without introducing another gateway:

```sh
agent-native-call --agent codex --steer-or-queue --delivery-only --resume \
  --session 11111111-1111-4111-8111-111111111111 \
  --correlation-id response-example --message 'Received request-example'
```

Use a distinct stable correlation for each response and bind it to the verified
recipient UUID. This option composes the existing `agent-steer` adapter and native
Codex queue. It steers an active turn; only exit 3 from that adapter, proving no
active turn and no send, permits queue fallback. `--resume` explicitly requests
activation after queueing an idle session. Other steer errors, missing or malformed
acknowledgement, and timeout retain uncertainty and never fall back to queue.

Both choices share one admission lease, payload deduplication and durable replay.
A held record decides steer versus queue when it is dispatched. Accepted results
report `status: "steered"` or `status: "queued"` and `deliveryMethod`; neither
proves transcript appearance, execution, reading or a response. A duplicate returns
the gate's existing receipt without another steer or queue operation. Observe the
exact correlated message in the recipient's transcript separately.

The cloud sender still needs an existing authorized relay or ingress that can run
this local transport. Do not infer that access from a cloud ID or a return address.
Do not also send through another return path, and never use a different correlation
to retry an unknown delivery. Direct `agent-session steer` remains the lower-level
adapter; this composed option supplies the durable gate for a response workflow.
