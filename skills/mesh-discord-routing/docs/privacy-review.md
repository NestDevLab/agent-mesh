# Privacy Review

Review date: 2026-05-27

## Scope

Public repository contents for `mesh-discord-routing-skill`.

## Checked

- No real Discord user IDs.
- No private bot or agent names.
- No server, channel, or guild IDs.
- No secrets, tokens, webhook URLs, or credentials.
- No local filesystem paths from a private runtime.
- No `participants.local.json` committed.
- Runtime adapter files are generic and use only fake participant IDs from
  `participants.example.json`.

## Allowed Public Placeholders

- Fake Discord IDs in `participants.example.json`.
- Generic labels such as `facilitator`, `reviewer`, and `ops-bot`.
- Generic config paths documented by the hydrator.

## Notes

Real deployments should keep participant mappings outside git through
`participants.local.json`, `MESH_PARTICIPANTS_JSON`, or an external config path.
