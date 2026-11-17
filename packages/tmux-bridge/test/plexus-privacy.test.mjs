import assert from 'node:assert/strict';
import test from 'node:test';
import { containsPrivatePlexusPolicy, isGeneratedPythonBytecode, isPlexusMechanismFile } from '../../../scripts/plexus-privacy.mjs';

test('only interpreter bytecode in cache directories is excluded from text scanning', () => {
  const tracked = new Set(['pkg/__pycache__/tracked.cpython-312.pyc']);
  assert.equal(isGeneratedPythonBytecode('pkg/__pycache__/example.cpython-312.pyc', tracked), true);
  assert.equal(isGeneratedPythonBytecode('pkg/__pycache__/example.cpython-312.opt-1.pyc', tracked), true);
  assert.equal(isGeneratedPythonBytecode('pkg/__pycache__/tracked.cpython-312.pyc', tracked), false);
  assert.equal(isGeneratedPythonBytecode('pkg/__pycache__/example.cpython-312.pyc', null), false);
  assert.equal(isGeneratedPythonBytecode('pkg/__pycache__/example.py', tracked), false);
  assert.equal(isGeneratedPythonBytecode('pkg/example.cpython-312.pyc', tracked), false);
  assert.equal(isGeneratedPythonBytecode('pkg/__pycache__/other.pyc', tracked), false);
});

test('Plexus public mechanism paths and private references are classified', () => {
  assert.equal(isPlexusMechanismFile('packages/tmux-bridge/bin/codex-compaction-evidence.mjs'), true);
  assert.equal(isPlexusMechanismFile('packages/tmux-bridge/test/codex-compaction-evidence.test.mjs'), true);
  assert.equal(isPlexusMechanismFile('skills/agent-tmux/bin/codex-compaction-evidence.mjs'), true);
  for (const path of ['packages/tmux-bridge/bin/codex-wake-evidence.mjs', 'packages/tmux-bridge/test/codex-wake-evidence.test.mjs', 'skills/agent-tmux/bin/codex-wake-evidence.mjs']) assert.equal(isPlexusMechanismFile(path), true, path);
  for (const name of ['isolated-role-rollback.py', 'codex-mcp-startup-notifications.mjs', 'trigger-journal.mjs', 'namespace-exec-gate.py']) for (const root of ['packages/tmux-bridge/bin/', 'skills/agent-tmux/bin/']) assert.equal(isPlexusMechanismFile(root + name), true, root + name);
  for (const name of ['isolated-role-rollback.test.py', 'codex-mcp-startup-notifications.test.mjs', 'trigger-cross-process.test.mjs', 'namespace-exec-gate.test.py', 'native-private-queue.test.mjs', 'claude-native-mailbox.integration.py']) assert.equal(isPlexusMechanismFile('packages/tmux-bridge/test/' + name), true, name);
  assert.equal(isPlexusMechanismFile('packages/tmux-bridge/bin/restart-state.mjs'), true);
  assert.equal(isPlexusMechanismFile('packages/tmux-bridge/test/restart-state.test.mjs'), true);
  assert.equal(isPlexusMechanismFile('skills/agent-tmux/bin/restart-state.mjs'), true);
  for (const path of ['docs/design/plexus.md', 'docs/design/plexus-modules.md', 'packages/tmux-bridge/README.md', 'packages/tmux-bridge/bin/plexus.mjs', 'packages/tmux-bridge/bin/mesh-graph.mjs', 'packages/tmux-bridge/bin/plexus-modules.mjs', 'packages/tmux-bridge/examples/plexus-example-module.mjs', 'packages/tmux-bridge/test/plexus-privacy.test.mjs', 'skills/agent-tmux/bin/agent-waker.py']) assert.equal(isPlexusMechanismFile(path), true, path);
  assert.equal(containsPrivatePlexusPolicy('/home/' + 'sample/private'), true);
  assert.equal(containsPrivatePlexusPolicy('private fixture marker', ['fixture marker']), true);
  assert.throws(() => containsPrivatePlexusPolicy('text', ['']), /invalid private markers/);
  assert.equal(containsPrivatePlexusPolicy('A configurable policy uses a synthetic session.'), false);
});
