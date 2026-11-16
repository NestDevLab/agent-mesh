# Restart state contract

A state file may carry a `RIAVVIO` YAML block. Its versioned content records
the session being replaced, its stable channel, harness, working directory,
skills, triggers and goal. Trigger configuration is opaque to Plexus and is
interpreted only by the responsible adapter. The block may contain private
paths and prompts and belongs in a private state file, not in the public repo.

```yaml
schema: agent-mesh.restart.v1
session: codex:example
channel: '#example'
harness: codex
working_directory: /workspace
skills: [example-skill]
triggers:
  - id: trigger-1
    kind: timer
    config:
      prompt: Perform the next check.
goal:
  objective: Finish the task.
  status: active
```

`skills` and `triggers` are arrays, including when empty; `goal` is either an
object or null. Trigger `(kind, id)` pairs are unique. A trusted adapter must
parse YAML with duplicate keys and unsafe tags rejected, bind the block to the
correlated old session and channel, and independently reconcile every trigger
with its source before using it. `validateRestartState` checks the decoded
object only: it is not a YAML parser, proof of authorship, scheduler or
authorization to recreate anything. Handover remains disabled until those
separate checks and final-notice verification are implemented.
