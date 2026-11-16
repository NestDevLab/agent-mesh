import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { observeClaudeDelivery } from '../bin/claude-delivery-observation.mjs';

const id = '22222222-2222-4222-8222-222222222222', session = `claude:${id}`;
const inbox = { schema: 'agent-mesh.monitor-inbox.v1', deliveryId: 'message-1', meshId: 'message-1', prompt: 'fixture' };
const options = { session, generation: 2, messageId: 'message-1', payload: 'fixture' };
const user = entry => ({ type: 'user', sessionId: id, message: { content: `Agent Mesh inbox records\nAGENT_MESH_INBOX ${JSON.stringify(entry)}` } });

test('only a unique correlated user transcript record proves local inbox observation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'claude-observation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(project, { mode: 0o700 });
  const path = join(project, `${id}.jsonl`);
  const put = rows => writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
  const message = user(inbox).message.content;
  await put([{ type: 'queue-operation', operation: 'enqueue', content: message }]);
  await assert.rejects(observeClaudeDelivery({ root, ...options }), /not uniquely observed/);
  await put([user(inbox)]);
  const proof = await observeClaudeDelivery({ root, ...options });
  assert.equal(proof.session, session); assert.equal(proof.generation, 2);
  assert.match(proof.evidence, /^claude-transcript:[a-f0-9]{64}$/);
  await assert.rejects(observeClaudeDelivery({ root, ...options, payload: 'changed' }), /correlation mismatch/);
  await put([user(inbox), user(inbox)]);
  await assert.rejects(observeClaudeDelivery({ root, ...options }), /not uniquely observed/);
  await put([{ ...user(inbox), sessionId: '33333333-3333-4333-8333-333333333333' }]);
  await assert.rejects(observeClaudeDelivery({ root, ...options }), /session mismatch/);
});
