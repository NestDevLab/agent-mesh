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
bind the block to the correlated old session and channel, and independently
reconcile every trigger with its source before using it. The `restart-yaml.py`
decoder requires PyYAML and rejects duplicate keys, aliases, anchors, explicit
tags, oversized input and non-JSON values. It accepts either a standalone YAML
file or a single `## RIAVVIO` section immediately followed by a fenced `yaml`
block. `validateRestartState` checks the decoded object; neither component is
a scheduler or authorization to recreate anything. Handover remains disabled
until trigger reconciliation and final-notice verification are implemented.
