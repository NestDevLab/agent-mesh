# Agent Mesh repository sync and skill conflict cleanup

Use this when work on the tmux/Agent Mesh skill changes local installed skills, runtime-b lookup behavior, or the `agent-mesh` repository.

## Durable lesson

Do not stop at fixing the installed runtime-b skill or the runtime copy. If `agent-mesh` is the source of truth for `agent-tmux-bridge`, update the repository, verify it, push it, then sync the installed skill from that source.

## Recommended sequence

1. Identify the canonical repo and installed skill paths.
   - Repo: `agent-mesh` checkout containing `skills/agent-tmux/` and `packages/tmux-bridge/`.
   - Installed skill: profile/global runtime-b skills tree that exposes `agent-tmux-bridge`.
2. Patch the repository first.
   - Keep `skills/agent-tmux/SKILL.md` as the authoritative skill content.
   - Keep bridge scripts/configs under `packages/tmux-bridge/` unless the installer intentionally materializes them into the skill copy.
3. Add repository-level verification for skill metadata.
   - Check every skill has `SKILL.md`, frontmatter `name`, `description`, and unique names.
   - Explicitly allow intentional directory/name mismatch: `skills/agent-tmux => name: agent-tmux-bridge`.
4. Run repo verification before reporting success.
   - Minimal: `npm run mesh:skills`.
   - Preferred: `npm run verify`.
5. Commit and push.
   - Verify local HEAD equals the remote branch ref with `git ls-remote origin refs/heads/<branch>`.
   - Report commit shorthashes, not just "pushed".
6. Sync installed skills from the repo.
   - Prefer a trusted local copy under the runtime-b skills tree over a symlink that points outside the skills tree, because some runtime-b skill security checks warn on external skill files.
   - Materialize needed bridge assets (`bin/`, `agents/`) into the installed skill copy if the skill expects them.
7. Remove or archive overlapping local helper skills.
   - If an older helper like `mesh-discord-routing` duplicates Agent Mesh routing/transport behavior, remove it from live lookup and archive it under `.archive/<sync-id>/...` rather than leaving two skills that both claim routing authority.
8. Verify live lookup.
   - `skills_list` includes `agent-tmux-bridge`.
   - `skill_view("agent-tmux-bridge")` succeeds.
   - Conflicting helper skill names no longer appear or resolve.

## Pitfalls

- Running an installer may chmod source scripts and leave mode-only git diffs. Inspect `git diff --summary` and revert accidental mode changes before commit.
- A symlink from the profile skills tree to a repo checkout can work functionally but trigger trusted-directory warnings. Use a copied/materialized install when the goal is a clean runtime-b runtime.
- Do not claim "synced" until both dimensions are true: repo remote has the commit, and the live runtime-b profile resolves the intended skill while conflicting helpers are absent.
