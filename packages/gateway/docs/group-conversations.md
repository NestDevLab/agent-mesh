# Authenticated group conversations

The MCP gateway can expose group list, history, append and send through a
separate host-side `mesh-group-broker`. It is disabled unless the operator
configures an absolute private Unix socket path and explicitly enables each
tool for a principal. The gateway never starts the broker or creates sessions.

Each principal needs a trusted `groupGrants` entry with `workspace_id`,
`session_id`, `group_ids` and optional `ledger_refs`. The workspace must already
be granted; group IDs and ledger refs are exact. Membership does not imply
permission to see or lock an item: without explicit `ledger_refs`, group
listings hide all item links and item lock tools fail closed. The host must
maintain these grants until an authoritative scoped ledger integration exists.
Tool arguments cannot supply the actor. The broker checks current
group membership, and cloud actors also need an open graph registration.
Group IDs outside the grant are never returned. For a cloud agent, use an
authentication identity bound exclusively to that session: an operator-created
binding alone does not prove which holder of a shared credential made a call.

The broker socket and parent directory must be owned by the gateway account and
inaccessible to other users. The broker accepts only peers with the same UID.
That UID is a trusted boundary: its processes can already use the local group
CLI and are not isolated from one another. Start and supervise the broker
separately; never expose its socket directly to an untrusted client.

History is paged, at most ten messages at a time. Append requires a stable
message ID and is idempotent for the same author and content. Send records the
message itself, then tries the requested members in order only after a proven
pre-delivery refusal. Do not append the same ID before sending. Held and
unknown outcomes are not proof of delivery and must not trigger blind retries.
The broker uses the existing communication gate. Its native transport determines
which destination providers are currently supported; registering a cloud member
alone does not enable cloud delivery.

The optional broker flag `--cloud-bindings` enables the separate cloud
transport when it is present. The broker reads the private binding immediately
before each cloud attempt, so revocation does not wait for a restart. A missing
or invalid binding blocks that attempt; local-only sends do not require it.
The transport still verifies the registered cloud identity and authenticated
account for each cloud attempt. A binding is not proof of message delivery.

Example configuration shape, with synthetic identifiers:

```json
{
  "groups": {"socketPath": "/run/example-groups/broker.sock"},
  "binding": {
    "allowedTools": ["mesh_group_list", "mesh_group_history", "mesh_group_append", "mesh_group_send"],
    "allowedWorkspaceIds": ["workspace.example"],
    "groupGrants": [{"workspace_id": "workspace.example", "session_id": "claude-cloud:example:session_Example1", "group_ids": ["group_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], "ledger_refs": ["work:item-1"]}]
  }
}
```

This example shows only the additional fields, not a complete gateway config.
Five separately allowed lock tools inspect, acquire, check, renew and release
the existing fenced item lease. The authenticated actor must currently belong
to the granted group and the item must be linked to it; the broker holds the
group database write reservation throughout the lease operation. The lease
owner is the bound session, never an argument. Inspection never returns the
lease ID; only a successful acquisition does. A lease owner who is not a
member of the requesting group is redacted, even when another group links the
same item. The state is host-local, so all
participants and guarded writers must use the same lock store. Writers must
still use `guard_item_write`; obtaining a lease alone does not enforce writes.
Removing membership prevents further API access, but does not revoke an
already issued lease; it remains valid until release or expiry.
Group creation, membership and item links have separate administrative tools.
These are disabled unless a trusted principal has `manageAllGroups: true`
and each specific tool in its allow-list. This is **global authority over the
entire broker**, not a workspace-scoped grant; use only a dedicated
administrator credential, never an ordinary participant identity. Creation
uses a caller-generated stable request ID: exact retries return the same group;
reusing an ID with different content fails. Administrative item links accept
the intersection of the current graph, group and lease reference formats.
No grant, service, credential or rollout is created by this code.
Graceful broker shutdown drains admitted requests before removing its socket.
Forced termination can leave delivery outcomes unknown and needs inspection.
