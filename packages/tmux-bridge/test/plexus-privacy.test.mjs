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
  for (const path of ['docs/design/plexus.md', 'docs/design/plexus-modules.md', 'packages/tmux-bridge/README.md', 'packages/tmux-bridge/bin/plexus.mjs', 'packages/tmux-bridge/bin/mesh-graph.mjs', 'packages/tmux-bridge/bin/plexus-modules.mjs', 'packages/tmux-bridge/examples/plexus-example-module.mjs', 'packages/tmux-bridge/test/plexus-privacy.test.mjs', 'skills/agent-tmux/bin/agent-waker.py']) assert.equal(isPlexusMechanismFile(path), true, path);
  for (const value of ['gale' + 'haut', 'management:' + 'MGT-123', '/home/' + 'administrator/private']) assert.equal(containsPrivatePlexusPolicy(value), true);
  assert.equal(containsPrivatePlexusPolicy('A configurable policy uses a synthetic session.'), false);
});
