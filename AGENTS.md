# AGENTS.md — Agent Mesh

This repository is intended to be portable and publishable under NestDevLab.

Rules for agents working here:

- Keep runtime-neutral code, protocols, adapters, examples, and tests in this repo.
- Do not commit private gateway config, Discord IDs, host paths, IPs, secrets, transcripts, or local deployment state.
- Keep OpenClaw-specific integration code generic and config-driven.
- Put local/private rollout manifests and service operations in the private ops hub, not in this repository.
- Before publishing, run `npm run verify` and a privacy scan for IDs, secrets, host paths, and customer/project-private names.
