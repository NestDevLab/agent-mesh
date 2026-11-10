# Agent Mesh groups

A group has an opaque, stable `group_id`, a display name and an optional stable
`role_key`. Names can repeat. The role describes the group independently of its
provider and members. Each assigned role key belongs to one group. Creating a group does not create a session, acquire a role
claim or change any existing claims.

## Local API

`agent-mesh group` returns JSON. Options follow the subcommand. Example:

```sh
group_id=$(agent-mesh group create 'Release planning' --role release:coordinator | jq -r .group_id)
agent-mesh group add "$group_id" runtime-a:session-1
agent-mesh group link "$group_id" tracker:release --lead
agent-mesh group list --ledger-ref tracker:release
printf '%s' 'The review notes are ready.' | agent-mesh group append "$group_id" \
  --as-session runtime-a:session-1 --message-id review-notes
agent-mesh group history "$group_id" --as-session runtime-a:session-1 --after 0 --limit 50
agent-mesh group remove "$group_id" runtime-a:session-1
```

- `create`, `add`, `remove`, `link`, `unlink` and `transfer-lead` are management
  operations. `add` and `remove` accept exact, case-sensitive namespaced session
  IDs resolved by the caller. Removing a member revokes access to the group and
  preserves messages the member authored. It does not change group roles or leads.
- `get` and `list` return group metadata, roster and ledger links. A session can
  see only its groups; a management actor can see all group metadata. Membership
  order does not determine routing priority.
- `append` and `history` require a current member, including when called by a
  management actor. Every current member can see the entire shared history; adding
  a member grants that access. Messages have a stable per-group sequence and
  author. To read another page, pass `next_after` as `--after`. Reuse the same
  `--message-id` on a retry; the same author and exact text return the stored
  message, and reusing the ID with different input fails. Appending does not
  send, broadcast or wake a session.

## Ledger references and lead

References are opaque exact strings. Several groups can link to the same ledger
reference and each group can link to several references. At most one group is
lead for any given reference. `link GROUP REF --lead` assigns a vacant lead.
`transfer-lead REF --from-group CURRENT --to-group TARGET` checks the expected
current lead and transfers it in one transaction to an already linked group.
`link GROUP REF --clear-lead` explicitly vacates a lead. An active lead must be
transferred or cleared before unlinking. Lead is group metadata; it grants no
ledger write permission, lock, session claim or routing preference.

Group links are available through `group list --ledger-ref REF` and `group get`.
They do not update the ledger itself or the session graph.

## Import an existing graph convention

An operator can preview the import from an explicit, reviewed local snapshot of
the numbered, migrated graph. Snapshots with incomplete link coverage are rejected.
The command never updates the graph or its original links.

```sh
agent-mesh group import-graph --snapshot graph.json --source local-graph --role-map roles.json
agent-mesh group import-graph --snapshot graph.json --source local-graph --role-map roles.json \
  --apply --plan-digest "$REVIEWED_PLAN_DIGEST"
agent-mesh group list --source-ref group:release-director
```

To import a subset, repeat `--include-group group:<slug>` for every selected group
on both preview and apply. The selection is included in the plan digest. The
entire supplied graph is still checked for conflicting ownership and its relevant
witnesses are bound to the plan; provide the complete snapshot, not a pre-filtered
one. An absent selection imports all groups as before.

Preview does not initialize or change the group database. It proposes one
stable group per `group:<slug>` with open `discusses` links to canonical local
sessions. To establish a lead for an area, an open `discusses` link must list
the exact `area:<slug>` in its `evidence` and an open `owns` link for that area
must list the exact group ref in return. Names need not match. Owners remain
evidence in the preview; the group holds the lead. Nonreciprocal evidence and
areas that point to competing groups block the import. Closed links and unrelated
work links are excluded. Unresolved candidate sessions and destination collisions
are reported.

The optional role map binds exact source refs to reviewed stable roles, for
example `{"group:release-director":"release:director"}`. Roles absent from the map
are left unassigned. Unknown group refs and duplicate role keys block import.
Imported groups have no inferred role claim or conversation history.

Apply rechecks the reviewed digest and current destination, then commits groups,
their unique source refs, members, lead links and the import receipt together.
The preview lists the exact open link IDs, their sessions and relevant evidence.
A changed witness invalidates the digest even when the projected group looks the
same. For a live cutover, use a fresh snapshot and verify the reviewed digest
against it before applying. The observed sequence is reported separately; the
command cannot tell whether a supplied offline snapshot is current.

For a live, single-host cutover on Linux, `mesh-group-import-live.py` obtains a
fresh graph snapshot inside an existing `role run` graph guard and imports it
before that guard is released. The worker fails closed without the guard proof
or Linux parent-death protection. Both preview and apply require the exact
active role claim and explicit graph and group state paths:

```sh
mesh-group-import-live.py --graph-state /path/to/graph --state /path/to/groups \
  --session codex:11111111-1111-4111-8111-111111111111 \
  --role operator --project sample --claim-id CLAIM \
  --source local-graph --include-group group:sample
# Repeat the same arguments with --apply --plan-digest REVIEWED_DIGEST.
```

The importer checks the plan and destination under the graph guard. A failed or
interrupted invocation may have committed: inspect the import receipt and
destination before retrying. This protects against cooperative graph writers
during import; it does not synchronize later legacy writes, retire old links,
or guarantee a complete migration. Arrange a separate writer handover.
Using the same source and plan again is a no-op, even after someone changes
group membership. A different plan for a source that was already imported needs
an explicit reconciliation; it never overwrites groups. Verify imported groups
and keep the original graph links until their separate retirement is authorized.

## Persistence and trust boundary

The local bridge is the API boundary in this version. Group data and conversation
history live in one private SQLite database on one host, under
`$XDG_STATE_HOME/agent-mesh/groups` (default `~/.local/state/agent-mesh/groups`).
`MESH_GROUPS_STATE` or `--state` selects another private local directory. Separate
processes using that directory share SQLite transactions. Distributed consistency,
multi-host writers and a remote endpoint are outside this contract.

The CLI is for the trusted OS account that owns the database. By default it can
manage groups; `--as-session` selects the membership-only view and is an
attestation by that account, not proof that the named runtime is the caller.
Do not expose this CLI as an untrusted subprocess endpoint. In-process callers
can use `GroupStore` and `GroupActor` from `mesh_group_store.py`; any remote
adapter must authenticate the actor, bind the exact session ID and grant management
authority independently before constructing `GroupActor`. Supplying a session ID,
registering a member or holding a role does not authenticate a caller.
