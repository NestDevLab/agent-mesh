import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { frameRestartDelivery } from '../bin/restart-delivery-frame.mjs';
import { observeClaudeRestartFrame } from '../bin/claude-restart-observation.mjs';

const id = '22222222-2222-4222-8222-222222222222', session = `claude:${id}`;
const body = 'fixture restart\n', digest = createHash('sha256').update(body).digest('hex');
const frame = frameRestartDelivery({ schema: 'agent-mesh.sealed-restart-delivery.v1', stateSha256: digest, text: body }).text;
const user = { type: 'user', sessionId: id, message: { role: 'user', content: frame } };

async function fixture(t, rows) {
  const root = await mkdtemp(join(tmpdir(), 'restart-observe-')); t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'project'); await mkdir(dir); const path = join(dir, `${id}.jsonl`);
  await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
  return { path, observe: () => observeClaudeRestartFrame({ root, session, frame, expectedStateSha256: digest }) };
}

test('unique exact user frame is observed without returning its private text', async t => {
  const f = await fixture(t, [user]); const proof = await f.observe();
  assert.equal(proof.session, session); assert.equal(proof.stateSha256, digest); assert.ok(!JSON.stringify(proof).includes(body));
});

test('duplicates, wrong session, sidechains and altered content are not proof', async t => {
  for (const rows of [[user, user], [{ ...user, sessionId: '33333333-3333-4333-8333-333333333333' }], [{ ...user, isSidechain: true }], [{ ...user, message: { role: 'user', content: `${frame} altered` } }]]) {
    const f = await fixture(t, rows); await assert.rejects(f.observe());
  }
});

test('partial records and a frame bound to another state fail closed', async t => {
  const f = await fixture(t, [user]); await writeFile(f.path, JSON.stringify(user)); await assert.rejects(f.observe(), /partial/);
  await assert.rejects(observeClaudeRestartFrame({ root: tmpdir(), session, frame, expectedStateSha256: 'a'.repeat(64) }), /digest/);
});
