import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyStateResponse } from '../bin/handover-state-proof.mjs';

test('state proof binds correlated response to private file bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'state-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = 'codex:22222222-2222-4222-8222-222222222222', filename = 'state.yaml', nonce = 'attempt-1';
  const content = 'version: 1\nnext: example\n';
  await writeFile(join(root, filename), content, { mode: 0o600 });
  const response = { schema: 'agent-mesh.handover-state.v1', session, nonce, filename, sha256: createHash('sha256').update(content).digest('hex') };
  const verify = (overrides = {}) => verifyStateResponse({ session, nonce, filename, root, response: JSON.stringify(response), ...overrides });
  assert.equal((await verify()).bytes, Buffer.byteLength(content));
  await assert.rejects(verify({ nonce: 'other' }), /binding/);
  await writeFile(join(root, filename), 'changed', { mode: 0o600 });
  await assert.rejects(verify(), /digest/);
  await chmod(join(root, filename), 0o644);
  await assert.rejects(verify(), /invalid state file/);
  await symlink(filename, join(root, 'alias.yaml'));
  await assert.rejects(verify({ filename: 'alias.yaml', response: JSON.stringify({ ...response, filename: 'alias.yaml' }) }));
});
