# Release Roadmap

## v0.9 preview

Purpose: close public/runtime-neutral gaps so the mesh can be tested seriously in live controlled environments.

Included:

- Mesh v1 parser and pre-dispatch state machine.
- Side-effect-free OpenClaw planning tool.
- Local dispatch harness with persistent state file.
- CI verification.
- Readiness privacy scan.
- Live testing plan and adapter contract.

Not included:

- v1.0 stability claim.
- Private live Discord config.
- Production gateway deployment manifests.

## v1.0

Release only after extended live use validates no partial wake-ups, no duplicate final dispatches, stable dedupe after restart, and safe loop behavior.
