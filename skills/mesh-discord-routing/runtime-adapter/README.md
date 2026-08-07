# runtime-b Adapter

runtime-b does not currently expose the same public plugin manifest shape used by
OpenClaw plugins in this repository, so this package ships a small bridge helper
instead of pretending there is a stable installable runtime-b plugin API.

Use `cc_mesh_bridge.py` from a runtime-b gateway hook or wrapper in two places:

1. Inbound: if `--mode addressed` returns `true`, treat the Discord message as
   addressed to the local runtime-b agent.
2. Outbound: run `--mode hydrate` before sending a Discord message; this turns a
   `cc-mesh:` line with semantic labels into canonical `cc-mesh:` plus mentions.

The bridge uses the same participant config as `mesh-hydrate`.

```bash
python3 runtime-b/cc_mesh_bridge.py \
  --mode hydrate \
  --config ~/.config/mesh-discord-routing/participants.json \
  --text 'cc-mesh: facilitator
Can you review this?'
```

The skill remains the first-class contract. The runtime-b helper only enforces the
contract when the runtime has a hook point available.
