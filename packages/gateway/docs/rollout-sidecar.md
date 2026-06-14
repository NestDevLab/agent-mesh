# Sidecar Rollout Notes

Status: package-local sidecar is the selected safe rollout path for this implementation slice.

## Decision

Use a sidecar-first integration before any plugin wrapper or config-driven runtime binding.

Reasons:

- it keeps OpenClaw core unchanged;
- it keeps Discord side effects behind explicit host-provided bindings;
- it preserves the package's append-only audit/replay model;
- it lets real smoke tests be allow-once and target-scoped;
- it avoids service restarts during validation.

A plugin wrapper can be added later as a thin adapter around the same facades. It should not reimplement policy, approval, idempotency, anti-loop, or persistence logic.

## Runtime boundary

The package remains library/sidecar code. Host runtime owns actual tool calls:

- Discord: host calls OpenClaw `message/send` only after `ControlledDiscordAdapter` and `OpenClawHostMessageSender` have produced an approved target/content/idempotency request.

Package code must not import or call OpenClaw tools directly.

## Allow-once test policy

Allowed for final smoke:

- Discord `message_create` only in the approved Agent Mesh Bootstrap thread/channel;
- no channel/thread mutations;
- no push, publish, deploy, restart, or delete;
- no secrets;
- no OpenClaw core changes.

## Final smoke evidence — 2026-05-11 UTC

Legacy runner smoke:

- endpoint: `default`;
- touched file inside temp workspace only: `smoke-result.json`;
- result: completed successfully.

Discord real smoke:

- target: Discord channel/thread `DISCORD_ID_PLACEHOLDER`;
- message id: `DISCORD_ID_PLACEHOLDER`;
- operation: one visible `message_create` smoke message;
- no channel/thread/object mutation beyond the message.

Verification commands after cleanup:

```bash
npm test -- --test-reporter=dot
./node_modules/.bin/tsc -p tsconfig.json --noEmit
```

Results:

- tests: 99 pass, 0 fail;
- typecheck: pass;
- local dependency cleanup: no package-local `node_modules` or `package-lock.json` retained.

## Promotion checklist

Before moving beyond sidecar smoke:

- [ ] choose whether to keep sidecar manually invoked or wrap it with a private OpenClaw plugin;
- [ ] define exact runtime config for host-provided Discord bindings;
- [ ] keep real sends allow-once by default;
- [ ] require explicit target allowlists for Discord;
- [ ] require backup and rollback notes before any persistent runtime deployment;
- [ ] do not push, publish, deploy, or restart without the operator's explicit approval.
