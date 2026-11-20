import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeClaudeFinalNotice } from '../bin/handover-claude-observation.mjs';

const id = '22222222-2222-4222-8222-222222222222';
const nonce = 'handover-33333333-3333-4333-8333-333333333333';
const message = 'Sleeping. Continue [here](codex://threads/22222222-2222-4222-8222-222222222222)';
const request = { type: 'user', sessionId: id, message: { content: `[HANDOVER:${nonce}] fixture` } };
const assistant = (content, stop = 'end_turn', nativeId = 'message-1') => ({ type: 'assistant', sessionId: id, message: { id: nativeId, stop_reason: stop, content } });
const answer = assistant([{ type: 'text', text: message }]);
async function fixture(t, records) {
  const root = await mkdtemp(join(tmpdir(), 'claude-notice-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(project);
  const path = join(project, `${id}.jsonl`);
  await writeFile(path, records.map(value => JSON.stringify(value)).join('\n') + '\n', { mode: 0o600 });
  return { root, path, observe: () => observeClaudeFinalNotice({ root, id, nonce, message }) };
}

test('a completed exact local Claude response is bound to its session and anchor', async t => {
  const f = await fixture(t, [request, assistant([{ type: 'thinking', thinking: 'synthetic' }]), answer]);
  const proof = await f.observe();
  assert.equal(proof.session, `claude:${id}`);
  assert.match(proof.transcriptSha256, /^[a-f0-9]{64}$/);
  assert.equal(proof.nonce, nonce);
});

test('later turns, tool use, incomplete answers and session mismatch fail closed', async t => {
  for (const records of [
    [request, answer, { ...request, message: { content: 'later turn' } }],
    [request, answer, assistant([{ type: 'tool_use', id: 'fixture', name: 'fixture' }], 'tool_use', 'message-2')],
    [request, assistant([{ type: 'text', text: message }], 'tool_use')],
    [request, assistant([{ type: 'text', text: message }, { type: 'tool_use', id: 'fixture' }], 'end_turn')],
    [request, { ...answer, sessionId: '44444444-4444-4444-8444-444444444444' }],
    [{ ...request, message: { content: 'wrong anchor' } }, answer],
    [request, assistant([{ type: 'text', text: `${message} extra` }])],
  ]) {
    const f = await fixture(t, records);
    await assert.rejects(f.observe());
  }
});

test('incomplete or hard-linked transcript is rejected', async t => {
  const f = await fixture(t, [request, answer]);
  await writeFile(f.path, JSON.stringify(request), { mode: 0o600 });
  await assert.rejects(f.observe(), /partial/);
  await writeFile(f.path, `${JSON.stringify(request)}\n${JSON.stringify(answer)}\n`);
  await link(f.path, join(f.root, 'other-link'));
  await assert.rejects(f.observe(), /invalid transcript file/);
});
