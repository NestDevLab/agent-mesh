import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRestartState } from '../bin/restart-state.mjs';

const sample = () => ({ schema: 'agent-mesh.restart.v1', session: 'codex:example', channel: '#example', harness: 'codex', working_directory: '/workspace', skills: ['example-skill'], triggers: [{ id: 'trigger-1', kind: 'timer', config: { prompt: 'Perform the next check.' } }], goal: { objective: 'Finish the task.', status: 'active' } });
test('restart block is bound to its original session and stable channel', () => {
  assert.equal(validateRestartState(sample(), { session: 'codex:example', channel: '#example' }), true);
  assert.throws(() => validateRestartState(sample(), { session: 'codex:other' }), /session mismatch/);
  assert.throws(() => validateRestartState(sample(), { channel: '#other' }), /channel mismatch/);
});
test('restart block rejects incomplete or ambiguous configuration', () => {
  for (const [key, value] of [['schema', 'other'], ['harness', ''], ['working_directory', null], ['skills', [null]], ['triggers', [{ id: 'x', kind: 'timer' }]], ['goal', {}]]) {
    assert.throws(() => validateRestartState({ ...sample(), [key]: value }), undefined, key);
  }
  const item = { id: 'x', kind: 'timer', config: {} };
  assert.throws(() => validateRestartState({ ...sample(), triggers: [item, item] }), /duplicate/);
  assert.equal(validateRestartState({ ...sample(), triggers: [], skills: [], goal: null }), true);
});
