# Work ledger item leases

`mesh-ledger lock` coordinates exclusive work on one canonical ledger item ref. A role claim and a
Plexus `works-on` link still describe session state. Neither is consulted when taking an item lease.
Leases require no adapter configuration and do not change the ledger or the graph.

1. Run `mesh-ledger lock inspect --ref work:example` and read its `fence` (initially zero).
2. Acquire with the observed generation:
   `mesh-ledger lock acquire --ref work:example --owner worker-a --expect-fence 0 --ttl 60`.
3. Retain the returned `leaseId` and `fence`. Pass both, together with the same ref and owner, to
   `renew`, `check`, or `release`. For example, the renewal arguments are
   `--ref work:example --owner worker-a --fence 1 --lease-id "$LEASE_ID" --ttl 60`.
   Renew before expiry and release when the work is finished.

TTL is in whole seconds, from 1 to 3600, and defaults to 300. Renewal preserves the generation and
extends the deadline to at least the requested TTL from now. At the expiry boundary the holder can
no longer renew, check as current, or release. A successful acquire increments the generation and
issues a fresh lease ID, including after expiry or release and when the next holder has the same
owner label. Keep the label unique to the worker or session for operator visibility.

All results are JSON with schema `agent-mesh.ledger-item-lock.v1`. Inspect returns the last generation
and `available`, `active`, or `expired`; an active lease has `remainingMs`. Inspection does not reveal
the lease ID or initialize a missing store. Acquiring requires both the observed generation and an
available or expired item in the same transaction. Exit 3 means the request did not mutate the item:
`conflict` means the observed generation changed, `held` means the generation matches an active
holder, and `stale` means the holder tuple is invalid or expired. Exit 1 with `busy` or `error` means
no authority was obtained; stop and inspect before trying again. A process that loses the successful
acquire response may have committed a lease; it can inspect and wait for expiry.

## Storage and concurrency

All participants for an item must use the exact same canonical ref and private state directory
(`MESH_LEDGER_LOCK_STATE_DIR`, default `${XDG_STATE_HOME:-~/.local/state}/agent-mesh/ledger-locks`).
The directory lives on a local filesystem on one Linux host and all participants use the same
kernel time namespace. Ref aliases and separate state directories create separate leases; the
application chooses the canonical ref. This is a cooperative single-host protocol, with no
cross-host replication or user authentication. Do not put the directory on a network share.

Each item uses its own SQLite file, with a name derived from the ref's SHA-256 digest. An exclusive
transaction serializes compare-and-swap, renew, and release, and SQLite releases transaction locks
and recovers uncommitted changes after process death. Transactions on different item files do not
contend for the same database lock. Deadlines use the kernel boot clock, including suspended time;
a reboot expires old holders and preserves their recorded generations. Released rows retain the
generation. Preserve the store across upgrades: deleting, restoring an older copy, or replacing
files while writers are running can invalidate the fencing sequence.

## Protecting the write itself

`check` is a point-in-time observation. A standalone check followed by an unguarded write leaves a
race between those steps. Every writer that needs exclusion must opt in at the commit boundary:

- A same-process local writer can use the Python `guard_item_write(ref, owner=..., fence=...,
  lease_id=..., directory=...)` context manager in `ledger_item_lock`. It validates the live lease
  and holds the same item transaction across a short, synchronous commit, such as replacing one
  prepared file. A successor cannot acquire while the commit is in progress, even if TTL passes.
  A stopped writer makes contenders report busy until it finishes or exits. The guard does not
  roll back the caller's file writes; use the ledger's own atomic commit operation. Do not hold it
  across remote calls, asynchronous jobs, subprocesses, or another item lease.
- A remote resource must enforce fencing atomically in its own write transaction, recording the
  highest accepted generation per item and rejecting earlier generations. This prevents a delayed
  write after the resource has observed a newer generation. Rejecting writes immediately at local
  lease expiry additionally requires validating the live lease at that resource's commit boundary.
  A separate check or an ignored fence cannot provide either guarantee.

Existing adapters, ledger writers, and graph links do not start enforcing leases automatically.
