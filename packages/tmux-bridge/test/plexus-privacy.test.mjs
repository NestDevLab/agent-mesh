import assert from 'node:assert/strict';
import test from 'node:test';
import { containsPrivatePlexusPolicy, isPlexusMechanismFile } from '../../../scripts/plexus-privacy.mjs';

test('Plexus public mechanism paths and private references are classified', () => {
  for (const path of ['docs/design/plexus.md', 'docs/design/plexus-modules.md', 'packages/tmux-bridge/README.md', 'packages/tmux-bridge/bin/plexus.mjs', 'packages/tmux-bridge/bin/mesh-graph.mjs', 'packages/tmux-bridge/bin/plexus-modules.mjs', 'packages/tmux-bridge/examples/plexus-example-module.mjs', 'packages/tmux-bridge/test/plexus-privacy.test.mjs', 'skills/agent-tmux/bin/agent-waker.py']) assert.equal(isPlexusMechanismFile(path), true, path);
  for (const value of ['gale' + 'haut', 'management:' + 'MGT-123', '/home/' + 'administrator/private']) assert.equal(containsPrivatePlexusPolicy(value), true);
  assert.equal(containsPrivatePlexusPolicy('A configurable policy uses a synthetic session.'), false);
});
