# AGENTS.md — Agent Mesh

This repository is intended to be portable and publishable under NestDevLab.

Rules for agents working here:

- Keep runtime-neutral code, protocols, adapters, examples, and tests in this repo.
- Do not commit private gateway config, Discord IDs, host paths, IPs, secrets, transcripts, or local deployment state.
- Keep OpenClaw-specific integration code generic and config-driven.
- Put local/private rollout manifests and service operations in the private ops hub, not in this repository.
- Before publishing, run `npm run verify` and a privacy scan for IDs, secrets, host paths, and customer/project-private names.

## tmux-bridge package

`packages/tmux-bridge/` contains shell scripts and agent config files for CLI-to-CLI intercommunication via tmux.

Rules specific to this package:

- Agent configs (`agents/*.conf`) must not contain absolute host paths, private IDs, or secrets — use `${HOME}` and relative references only.
- Scripts must derive the repo root from their own location (`$(dirname "$0")/...`) rather than hardcoding it.
- Adding a new agent config is sufficient to support a new CLI; no changes to the shared scripts are needed.

## Skills

`skills/` contains Claude/Codex skill definitions (`SKILL.md` + `ASSISTANT.md`) for the tmux bridge.

- `skills/codex-tmux/` — skill for Claude to control Codex via tmux.
- `skills/claude-tmux/` — skill for Codex (or any agent) to control Claude Code via tmux.
- Skills reference `$AGENT_MESH_ROOT` for the bin path; no absolute paths are hardcoded.
- Install symlinks with `scripts/setup-skills.sh` (auto-detects the runtime skills directory).
