# Global session controller

`bin/session-controller.py` is the single deterministic user-service loop. It calls
no model on a quiet cycle. Project Directors run only on external input: they must
not create cron jobs, recurring automations, event timers, or self-renewal loops.

Plexus role `global-controller` is globally unique, including across projects and
runtimes. Register an existing native session, claim with `--project global`, and
put its exact session and claim IDs in private configuration. Never use a local
Director claim for this process. The controller heartbeats the global claim, maintains only already-active project Director leases with the fenced `role maintain` operation, and
runs observation/enqueue inside `role run`; takeover fences the old dispatcher.
A local nonblocking lock also rejects duplicate processes using the same state.
Restart never silently steals an expired or superseded claim: inspect and use an
explicit named native takeover only when authorized.

Configuration (private paths, identities and repository names stay outside source):

```json
{
  "session": "codex:<native-uuid>",
  "claim_id": "<exact-global-claim>",
  "owner_project": "global",
  "mesh_bin": "<installed-bridge-bin>",
  "state": "<private-state>/controller.json",
  "mode_file": "<fallback-state>/mode",
  "managed_inbox_root": "<managed-inbox-root>",
  "interval": 60,
  "follower_config": "<private-follower-scope.json>",
  "projects": [{
    "id": "example",
    "cwd": "<project-root>",
    "director_state": "<project-state.json>",
    "ledger": ["<ledger-root>/*.md"],
    "event_files": ["<project-controller-inbox.jsonl>"],
    "shared_event_files": ["<follow-root>/global-controller/outbox.jsonl"],
    "repositories": ["example/project"]
  }]
}
```

Event files contain newline-terminated JSON objects. Dedicated project inputs may
omit `project`; shared files require an explicit project or a follower `ref` with
that project in the native catalog. Bootstrap starts at complete EOF. Partial rows
stay unread; truncation and malformed rows are errors. Ledger baselines do not wake
models; later changed/deleted/new files do. The one controller invokes the existing
read-only follower for one bounded observation pass, including worker turn results.
PR/CI snapshots use read-only `gh pr list`. These adapters run outside the short
Plexus lock; all enqueue attempts are fenced under the exact claim.

Open `threads.*.wait.until` deadlines and six hours without observed project
activity create events. Activity comes from native catalog `last_activity_at`,
unresolved thread activity, or new ledger, external input and PR/CI transitions.
Lease renewals, polling timestamps and recap watermarks do not count as activity.
Unknown activity starts a six-hour observation window; future timestamps cannot
postpone the safety check. Safety requests are limited to one per six hours.
Pending legacy recap or stale safety observations move into `retired_pending`
receipts without losing their payloads. Unknown in-flight batches still require
explicit reconciliation before any further delivery.

This loop never schedules or sends a Director recap. A single global recap at
08:30/13:30/18:30 Europe/Amsterdam belongs to the existing host digest workflow,
which supplies the model-written cross-project text and delivery policy. Do not
add a second sender or enable this loop as a substitute for that integration.

Routine new digests receive one bounded `codex exec --sandbox read-only` triage,
with schema-constrained output and no worker/schedule/message authorization. The
Codex CLI keeps its configured model routing. Quiet digests are acknowledged
without waking a Director. Actionable routine digests and judgment/deadline/safety
events go only to the affected project's currently claimed Director in the runtime
selected by the authoritative fallback mode file. Claude mode routes to Claude;
Codex mode routes to Codex. An absent, ambiguous or expired claim blocks delivery
and retains pending work. Mode changes must use the existing fallback handover
protocol; the controller does not infer quota from a probe or overwrite mode files.
The existing return watchdog may remain separate until its own controlled migration.

Every message starts with a fixed data-only prefix. Observations are durable before
delivery. Native queue acknowledgement advances pending work, not task completion.
An interrupted enqueue leaves `dispatching` as an explicit unknown outcome and
refuses blind retries: inspect the correlation ID in the recipient transcript,
then stop the service and run the controller with `--reconcile <project>
--correlation-id controller-<id> --confirmed-outcome queued|refused` under the same
active claim. This reconciles only the named batch; restart the service afterward. Never delete the cursor
to recover. Per-project errors appear in `last_cycle.errors` and the service journal.

Install a user unit only after reviewed source rollout and a private rollback receipt
containing old unit/config contents plus prior active/enabled states:

```ini
[Unit]
Description=Global deterministic session controller
[Service]
Type=simple
ExecStart=<python> <installed-bin>/session-controller.py --config <private-config>
Restart=on-failure
RestartSec=30
[Install]
WantedBy=default.target
```

Verify a fresh cycle, exclusive claim, real native delivery and recipient receipt
before disabling a project's old self-ticks. Migrate one project at a time. Keep
old job definitions in the rollback receipt, but do not leave them active alongside
the controller. Rollback stops the controller first, restores previous unit/config
and schedules, then releases only its own exact Plexus claim. `--once --observe-only`
collects and persists inputs without triage or delivery, but still requires the claim.

Each normal controller cycle runs the installed `mesh-comms.py sync` once after
acquiring the fallback mode guard, before the first Plexus `role run`. The gate
owns fallback-mode/hold interpretation and scoped queue restoration. Sync and its
replay never run under the Plexus graph lock. Sync failure stops the cycle before
triage or enqueue. Observe-only cycles and explicit receipt reconciliation never
run sync. Deploy the communications-switch module before enabling this hook.
