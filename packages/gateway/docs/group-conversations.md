# Authenticated group conversations

The MCP gateway can expose group list, history, append and send through a
separate host-side `mesh-group-broker`. It is disabled unless the operator
configures an absolute private Unix socket path and explicitly enables each
tool for a principal. The gateway never starts the broker or creates sessions.

Each principal needs a trusted `groupGrants` entry with exactly `workspace_id`,
`session_id` and `group_ids`. The workspace must already be granted; each group
ID is exact. Tool arguments cannot supply the actor. The broker checks current
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
    "groupGrants": [{"workspace_id": "workspace.example", "session_id": "claude-cloud:example:session_Example1", "group_ids": ["group_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}]
  }
}
```

This example shows only the additional fields, not a complete gateway config.
Group creation, membership changes and ledger links remain host management
operations. No grant, service, credential or rollout is created by this code.
Graceful broker shutdown drains admitted requests before removing its socket.
Forced termination can leave delivery outcomes unknown and needs inspection.
