import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const bin = fileURLToPath(new URL('../bin/agent-native-call.mjs', import.meta.url));

test('native transport parses bounded stdin before rejecting unsupported agent', () => {
  const args = [bin, '--agent', 'fixture', '--session', 'fixture', '--correlation-id', 'fixture', '--message-stdin'];
  const valid = spawnSync(process.execPath, args, { input: 'private fixture', encoding: 'utf8' });
  assert.notEqual(valid.status, 0);
  assert.match(valid.stderr, /not implemented/);
  assert.ok(!valid.stderr.includes('private fixture'));
  const oversized = spawnSync(process.execPath, args, { input: 'x'.repeat(65537), encoding: 'utf8' });
  assert.notEqual(oversized.status, 0);
  assert.match(oversized.stderr, /stdin message too large/);
});
