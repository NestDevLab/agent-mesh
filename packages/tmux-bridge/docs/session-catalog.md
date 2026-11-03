# Session catalog and role claims

The existing graph event stream is the canonical catalog and claim ledger. No extra owner files
are authoritative. Discovery includes Claude and Codex persisted sessions; unspecified roles remain
`unclassified` rather than inferring authority from titles. Catalog labels and runtime status are
separate: a label does not grant a lease or prove a process is running.

```sh
mesh-graph catalog backfill --agent claude
mesh-graph catalog backfill --agent codex
mesh-graph catalog register --session codex:<uuid> --role worker --project example --title "Implement search"
mesh-graph catalog update --session codex:<uuid> --status waiting
mesh-graph catalog list --project example
mesh-graph role claim --session claude:<uuid> --role director --project example
mesh-graph role heartbeat --session claude:<uuid> --role director --project example --claim-id <claim-id>
mesh-graph role check --session claude:<uuid> --role director --project example --claim-id <claim-id>
mesh-graph role release --session claude:<uuid> --role director --project example --claim-id <claim-id>
mesh-graph role list
```

Registration inspects the native transcript when the session is new. Backfill reads full transcript
history using the discovery path, keeps explicit catalog titles, and reports skipped sources. Claude
briefs following `</note>` supply the title; instruction-only Codex messages are skipped.

`director` is singleton per project. `daily` and `holding-director` are global singleton roles.
Other lowercase slug roles are supported and their explicit claims are logged per project/session.
Claims use the graph lock and one event per transition. The default TTL is 4200 seconds;
`--ttl` accepts 1 through 86400 seconds. Merely observing session activity does not renew a lease.
Heartbeat, check and release require the exact returned claim id. Expired owners are reported as
`stale` and cannot heartbeat; even a stale claim requires explicit takeover naming its claim id:

```sh
mesh-graph role claim --session codex:<uuid> --role director --project example \
  --take-over <incumbent-claim-id> --reason "Explicit handoff"
```

A takeover atomically marks the previous claim and session superseded, closes its open ledger links
and lineage edges and copies them to the successor (omitting self edges). The old token is fenced.
An explicit same-session renewal also requires the incumbent id once expired and generates a new token.
Automatic clients must never add takeover to a conflict retry. A live takeover is an operator decision.

This is cooperative exclusion: consumers must acquire before starting, check the token before every
state mutation and heartbeat during work. An expired or superseded writer must stop immediately.
A claim alone cannot kill a process or make an unrelated filesystem write atomic with lease checking.
Use the Director state writer's integration for enforced checks at the write boundary.

The CLI exposes mutations locally. Existing scoped gateway queries retain their authorization
boundaries; the local catalog and claim ledger must not be exported as an unscoped remote MCP tool.

A local consumer can execute a bounded state command while holding the same graph lock as takeover:
`role run` takes the usual lease identity plus `--input -`, reading JSON `{ "argv": ["program", "arg"],
"stdin": "optional input" }` from stdin. No shell is used. It checks the exact unexpired lease and
holds the lock until the child exits (30 second timeout). The child receives guard PID and claim
markers. This local operator primitive is never exposed by the gateway. Only short state commands
belong here; the attention loop itself must not hold the graph lock.

A session holds one outstanding role claim at a time. Release it before changing role or project;
the holder may release an expired claim with its exact token. This prevents a partial takeover from
silently fencing unrelated grants.
