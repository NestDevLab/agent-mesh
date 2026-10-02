# Standalone systemd deployment

Agent Mesh owns the generic MCP unit and runtime-directory preparation. No fleet
controller is required. A host may supply its own units and use the same helper
with `--directories-only`; do not copy the directory-creation logic into an overlay.

Prerequisites: Linux with systemd and `systemd-tmpfiles`, a non-root service
account, Node matching the package engine, and an already built Mesh release.
Supply the protected runtime JSON and environment file described in
[MCP ingress](mcp-ingress.md). Authentication, tunnel configuration and credentials
remain operator inputs; this installer does not create or expose them.

From the release root, review the generated unit and tmpfiles plan:

```bash
node packages/gateway/scripts/install-systemd.mjs \
  --uid "$(id -u)" --gid "$(id -g)" --release-dir "$PWD"
```

Add `--apply` under sudo after reviewing that plan. It installs
`/etc/systemd/system/agent-mesh-mcp.service` and
`/etc/tmpfiles.d/agent-mesh-<uid>.conf`, prepares the persistent state directory,
and runs **only** `systemd-tmpfiles --create` for its own rules. It does not enable,
start, restart or reload services. Back up existing deployment files before
replacing them. To activate a new standalone gateway:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now agent-mesh-mcp.service
```

The defaults are `/var/lib/agent-mesh-mcp`,
`/etc/agent-mesh-mcp/runtime.json`, `/etc/agent-mesh-mcp/environment`,
`/tmp/agent-mesh-<uid>` and `/tmp/tmux-<uid>`. Configure the release, state,
JSON, environment and Node paths with the corresponding options in `--help`.
For native session providers, explicitly add each approved writable runtime home
using repeated `--write-path` arguments. Project directories remain read-only.
The template stays bound to loopback; an authenticated reverse proxy is required.

Every boot runs tmpfiles before the unit starts, recreating absent directories
with mode `0700` and the configured numeric UID/GID. Explicit `d` rules also keep
the directories outside their parent's age-based cleanup. Repeated installation
does not delete live bridge files or tmux sockets. `--check` verifies installed
contents and directory ownership/mode without writing.

An existing deployment may install just the runtime rules:

```bash
node packages/gateway/scripts/install-systemd.mjs \
  --uid "$(id -u)" --gid "$(id -g)" --directories-only
```

Again, `--apply` performs the reviewed plan. Existing custom units must run after
`systemd-tmpfiles-setup.service` and use the same directory paths. Preparation
must happen outside their filesystem sandbox: a launcher cannot create a path
which systemd requires before invoking that launcher.

`--root TEST_ROOT` supports isolated filesystem tests; it neither chroots nor
starts services. The regression test uses the real tmpfiles executable with a
`D /tmp` rule and missing Mesh directories, then checks recreation and permissions.
Linux acceptance requires this test to run rather than skip. No real reboot or
deletion of host runtime directories is needed.
