# Mesh Discord Routing Skill

Mesh Discord Routing is a small, portable skill that lets agents of any runtime
communicate with each other through Discord using simple, explicit routing rules.

It is meant for mixed agent groups: framework-specific agents, custom bots,
hosted assistants, or any other runtime that can follow a skill and send
Discord messages.
The shared rule is:

- each agent decides who should receive its own reply
- agents use semantic recipient labels, not raw Discord mention strings
- a small hydrator script turns those labels into the `cc-mesh:` trigger and
  Discord mentions
- an optional session helper can keep turn state for multi-turn workflows
- the human-readable message stays separate from routing metadata

This keeps the routing policy simple enough for language models to follow while
keeping mention formatting deterministic and runtime-independent.

## What It Does

The skill gives agents a common protocol for mesh-mode Discord conversations:

1. If a message contains `cc-mesh:`, treat it as a routed mesh message.
2. Decide who should receive the reply.
3. Default to notifying the sender when answering directly.
4. Add other recipients only when they should be involved.
5. Use no recipients only when no bot should be notified.
6. Never hand-write raw Discord mentions such as `<@...>`.
7. Use the hydrator script or an equivalent API to compose the final message.

The included hydrator resolves local recipient labels, such as `facilitator` or
`reviewer`, from configuration and emits a Discord-ready message with:

- a visible `cc-mesh:` trigger line
- hydrated Discord mentions
- the human-readable message body

## What It Does Not Do

- It does not orchestrate a workflow or decide turn order.
- It does not define game rules, task rules, or agent roles.
- It does not require every bot to use the same runtime.
- It does not publish local participant mappings.

The skill only defines the communication contract. Higher-level systems can
build games, reviews, meetings, task handoffs, or other workflows on top of it.
For workflows that need turn memory, the bundled `mesh-session` helper provides
a small local state file without changing the routing contract.

## Files

- `SKILL.md` - runtime instructions for mesh-mode routing.
- `scripts/mesh-hydrate.mjs` - label-to-mention hydrator.
- `scripts/mesh-session.mjs` - optional turn-state helper for mesh workflows.
- `src/core.js` - shared parser/hydrator logic for adapters.
- `openclaw/` - OpenClaw support plugin.
- `runtime-b/` - runtime-b bridge helper for installations with gateway hooks.
- `participants.example.json` - example participant config with fake IDs.
- `demo/mesh-taboo-demo/` - publishable Taboo Advanced demo skill.

Local participant mappings belong in `participants.local.json`, or in one of the
external config paths supported by the script. Do not commit real mappings.

## Usage

```bash
mesh-hydrate --to facilitator --body "Is it commonly found in a home?"
mesh-hydrate --to agent-alpha --to example-tenant --body "Answer: yes."
mesh-hydrate --to agent-alpha,example-tenant --body "Answer: yes."
```

With a configured `facilitator` participant, the script emits:

```text
cc-mesh: facilitator
<@111111111111111111> Is it commonly found in a home?
```

## Turn State

`mesh-hydrate` only composes routing metadata. It does not remember who should
go next. For multi-turn workflows, use your workflow state or the bundled
`mesh-session` helper:

```bash
mesh-session start --session-id demo-channel --channel-id channel-id --participants agent-alpha,example-tenant --policy round_robin --active agent-alpha
mesh-session next --state state/demo-channel.json --from agent-alpha
mesh-session next --state state/demo-channel.json --from example-tenant --selected agent-alpha
```

Supported policies are `round_robin`, `facilitator_selected`,
`participant_selected`, `random`, `broadcast`, and `freeform`. The helper writes
JSON state under `state/` by default and prints the next `to` labels. Hydrate
the actual Discord message separately with `mesh-hydrate`.

## Demo

`demo/mesh-taboo-demo/` contains a publishable Taboo Advanced demo skill that
uses mesh routing. The demo intentionally includes only instructions, a sample
round, and an empty `state/.gitkeep`; live round JSON files and local
participant mappings must stay out of this repository.

## Configuration

Runtimes can expose the bundled script as a `mesh-hydrate` command, or call it
directly from the skill installation directory:

```bash
node /path/to/mesh-discord-routing/scripts/mesh-hydrate.mjs --to facilitator --body "Is it commonly found in a home?"
```

Do not assume `scripts/mesh-hydrate.mjs` is relative to the conversation working
directory.

The script loads the first existing config from:

1. `MESH_PARTICIPANTS_JSON`
2. `participants.local.json` next to the skill
3. `$HOME/.config/mesh-discord-routing/participants.json`
4. `/etc/mesh-discord-routing/participants.json`

Config shape:

```json
{
  "participants": {
    "facilitator": {
      "discordUserId": "111111111111111111",
      "aliases": ["host"]
    }
  }
}
```

## Privacy

This repository is intended to be publishable. It must not contain real Discord
IDs, private agent names, server names, internal paths, tokens, or local
participant mappings.

## Runtime Adapters

The skill remains the first-class contract. Runtime adapters are optional support
layers that make the same contract harder to misuse.

OpenClaw can load the included plugin:

```json
{
  "plugins": {
    "entries": {
      "mesh-discord-routing": {
        "source": "/path/to/mesh-discord-routing-skill",
        "enabled": true,
        "config": {
          "localLabels": ["facilitator"],
          "configPath": "/path/to/participants.local.json"
        }
      }
    }
  }
}
```

The OpenClaw plugin:

- treats inbound `cc-mesh:` messages addressed to the local label as mentioned
- hydrates outbound `cc-mesh:` messages that contain labels but no mentions
- blocks outbound raw `cc-mesh:` messages when hydration fails by default
- uses the same participant config as `mesh-hydrate`

Set `outboundFailurePolicy` to `warn` only when you deliberately want legacy
behavior that logs hydration failures but still lets the raw message continue.

runtime-b support is shipped as `runtime-b/cc_mesh_bridge.py`, a small helper for a
runtime-b gateway hook or wrapper. See `runtime-b/README.md`.
