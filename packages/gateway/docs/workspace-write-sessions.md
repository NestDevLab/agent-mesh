# Isolated writable MCP sessions

Status: source implementation; deployment is opt-in. No repository is enabled by default.
The private application gateway can compose this provider using the existing workspace MCP hub;
no import from the private gateway into Agent Mesh is needed.

## Public contract

`mesh_call` and `mesh_submit` accept `access_mode: "read-only" | "workspace-write"`.
Omission means read-only for new sessions. A resumed managed session inherits its recorded mode;
an explicit different mode fails. `session_mode: "fresh"` selects creation independently of access.
Neither the client argument nor a provider's permission flag grants filesystem access.

```json
{
  "target_agent_id": "agent.ingress.codex",
  "workspace_id": "workspace.example.repo",
  "session_mode": "fresh",
  "access_mode": "workspace-write",
  "message": "Implement the bounded change and run its tests.",
  "idempotency_key": "example-change-1"
}
```

Use the returned `session_id` on subsequent requests. Codex's native ID replaces the provisional
UUID in both the task and session provenance, including delivery failures that report a native ID.
Tasks expose effective `access_mode`, status, correlated IDs, results and errors through the
existing task API. Gateway task events retain authenticated principal, worker, workspace and mode.
Fresh-session interruptions are not automatically retried. Worker replay uses stable input hashes,
not mutable task status/timestamps; interrupted worker operations return `delivery_uncertain`.

## Trust boundaries

The gateway retains its existing read-only OS namespace and authentication policy. It only sends
JSON to a private Unix socket; it never starts workers or invokes Bubblewrap. Writable tasks do not
use the legacy host socket transport. Every worker has **one exact principal, agent, workspace,
repository and access mode**. It rechecks that tuple before execution. There are no wildcard grants,
shared sockets across routes, automatic directory selection or global write enablement.

The owner starts a separate Linux Bubblewrap worker from a reviewed immutable release. It creates
new user, mount, PID, IPC, UTS and cgroup namespaces, drops capabilities, clears the environment,
and does not mount host homes, host temporary directories, app-server sockets or gateway state.
The root is an empty private filesystem; runtime directories and the release are read-only.
Canonical repository/home/temp/control directories must be disjoint. The launcher opens directory
descriptors with `O_NOFOLLOW`, verifies their resolved paths and binds the pinned descriptors.
Symlinks within the repository resolve only inside this namespace. There is no fallback if the
kernel disallows namespaces, Bubblewrap fails or the worker socket is missing.

Only the selected repository is host-backed RW in write mode. RO workers bind it read-only.
Provider home, private temporary storage and the worker control directory are additional RW
operational state, **not additional repository grants**. Use separate owner-only (0700) directories
for every route; never reuse them between principals or modes. The socket is 0600. Gateway and
worker launcher must use the same dedicated service identity for this initial Unix-socket transport;
expose only the exact socket/control path to the read-only gateway, never the worker's home or repo RW.
The gateway's protected task journal is the authoritative audit. The worker's journal contains
principal/workspace/mode, input hashes and receipts; it is recovery evidence, not an audit trusted
against that worker's own agent (which can access its operational state).

Network access is retained for provider APIs and development tools. This is filesystem isolation,
not an egress policy. Provide only provider-specific authentication in the dedicated worker home;
never inherit personal SSH agents, cloud credentials, host CLI configuration or the gateway's
credentials. The worker cannot mount additional host paths. Writable repositories must not include
production data or unrelated secrets. Host owners and processes outside the sandbox with the same
service UID remain trusted; this is not a hostile-host isolation boundary.

Provider permission modes are separate: Codex launches `--sandbox workspace-write` and
`--ask-for-approval never` inside the OS namespace; RO Codex uses `--sandbox read-only`. Claude uses
`acceptEdits` and explicit development tools (Read/Edit/Write/Bash/Glob/Grep) in writable workers;
RO uses default permissions with read/command tools. These flags cannot enlarge the outer mounts.
No new `danger-full-access` path is added. The pre-existing separately configured legacy
`mesh_agent_session_create` full-access feature is unchanged and is not used by this protocol.

## Owner configuration and activation (requires separate approval)

1. Build and verify the governed source, then deliver through the repository's normal pipeline.
   Install the reviewed release only through the owning deployment/Agentwheel configuration.
   Keep private configuration in the private operations source, never in this portable repository.
2. Select **one repository**, its exact authenticated principal ID, provider/agent ID and workspace
   ID. Use a repository root with its canonical `.git` directory inside that root (nested governed
   worktrees can then refer back to it). A checkout whose git-dir lives outside the grant is not
   auto-mounted or supported as a root. Do not use a workspace parent directory as a repository grant. Create separate configs and
   private state directories for read-only and workspace-write, and separately for Claude/Codex.
   See `../examples/workspace-worker.json` for the worker shape; all values are synthetic.
3. Provision worker-specific provider authentication and self-contained CLI binaries visible through
   `/usr`, `/usr/local`, or the read-only release (with their launchers available on the worker PATH).
   Symlinks to binaries under a host user's hidden home do not work. Confirm Linux user namespaces,
   `/usr/bin/bwrap`, Node, Bash, Python and tmux are available. Do not copy an entire personal home.
4. Start the worker under the approved owner-managed supervisor, outside the read-only gateway:
   `node /opt/mesh-worker/release/packages/gateway/dist/mcp/workspace-worker-server.js /private/worker.json`.
   The launcher itself needs the ability to create namespaces. Do not weaken the running gateway's
   sandbox or self-modification protections to launch it. Direct `--inside` invocation outside the
   validated namespace fails. The worker and all its tmux descendants remain in that namespace;
   stopping its launcher kills the namespace. Never remove a socket while its worker may be alive.
5. Add an exact route to the gateway runtime config in its owning private source, for example:

   ```json
   {
     "workspaceWorkers": [{
       "id": "worker.example.codex.write",
       "principalId": "principal.example",
       "agentId": "agent.ingress.codex",
       "workspaceId": "workspace.example.repo",
       "accessMode": "workspace-write",
       "socketPath": "/srv/mesh-control/example-codex-write/worker.sock"
     }]
   }
   ```

   Existing authenticated binding tool/agent/workspace/domain allowlists must also permit the task.
   No token or credential goes into the route. A missing/revoked route fails even for an existing
   session; removing a route never sends that session through the legacy transport.
6. Review the owning deployment/Agentwheel dry-run and obtain authorization before install,
   gateway config activation, service changes or restarts. No live config, mounts, ACL or systemd
   changes are part of this source delivery.
7. Refresh the client's MCP tool schemas. Use a disposable repository to validate both providers,
   read-only denial, write create/edit/delete, outside-path and symlink denial, principal denial,
   resume invariance, native IDs and correlated results. Only then enable the selected real repo.

For **legacy read-only Codex fresh tasks**, independently opt in with
`agentSessions.providers[].fresh_session.task_sessions: true`. This boolean is Codex-only and
requires trusted `workspace_cwd`; it does not enable writable tasks. The old default remains off.
The symlink entrypoint correction and target-existence check fix the previous silent Codex resume
failure. Resume remains subject to the bridge's unique-writer checks and preserved provider policy.

## Rollback and limitations

Remove the exact gateway route to stop new submissions and resumes. This does not cancel an already
running command: stop that worker's approved supervisor to terminate its namespace and descendants.
Keep gateway task events, worker receipts and the dedicated provider home for diagnosis/recovery.
Restore the prior approved source/config release through the same deployment process; never migrate
writable sessions into the legacy gateway socket or relabel them read-only. After proving no worker
owns a stale socket, its owner may remove that socket before restarting. No automatic deletion is done.

Cancellation changes task state but does not guarantee subprocess termination; worker shutdown is
required to revoke an in-flight filesystem capability. Removing a grant does not undo repository edits.
Existing sessions from outside these workers cannot be adopted as writable. They require a new fresh
session. Active external Claude writers still fail closed where the existing safe transport cannot
prove ownership; inactive sessions resume through the existing adapter. A worker restart terminates
its namespace, after which owned persisted sessions can resume without changing mounts or mode.

Automated tests cover real filesystem isolation, worker startup/shutdown, admission, schemas,
idempotency, native IDs and adapter fixtures. They do not authenticate to paid provider APIs or prove
that an installed CLI/authentication setup works in production. Live Claude/Codex turns and private
operations configuration remain activation acceptance, not a claimed result of fixture tests.
