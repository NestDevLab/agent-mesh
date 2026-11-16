import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queueLocalFinalNotice, observeLocalFinalNotice } from '../bin/handover-notice-transport.mjs';
import { formatFinalNotice } from '../bin/handover-notice.mjs';

const id = '22222222-2222-4222-8222-222222222222';
const nonce = 'handover-33333333-3333-4333-8333-333333333333';
const options = { session: `claude:${id}`, nonce, target: { kind: 'codex', id }, prefix: 'Sleeping.', label: 'Continue here', managedInboxRoot: '/synthetic/inbox' };
const notice = formatFinalNotice(options);
const response = { status: 'queued', agent: 'claude', sessionId: id, correlationId: nonce };

test('native adapter sends the correlated notice request on stdin and reports queue only', async () => {
  let called = 0;
  const queued = await queueLocalFinalNotice(options, async (command, args, config) => {
    called++;
    assert.equal(command, process.execPath);
    assert.ok(args.includes('--delivery-only'));
    assert.ok(args.includes('--managed-inbox-root'));
    assert.ok(args.includes('--message-stdin'));
    assert.ok(!args.includes(notice));
    assert.ok(config.input.includes(`[HANDOVER:${nonce}]`));
    assert.ok(config.input.endsWith(notice));
    return { stdout: JSON.stringify(response) };
  });
  assert.equal(called, 1);
  assert.equal(queued.status, 'queued-unverified');
  assert.equal(queued.session, options.session);
  assert.match(queued.noticeSha256, /^[a-f0-9]{64}$/);
});

test('a held, mismatched or failed enqueue is never declared delivered', async () => {
  for (const value of [{ ...response, held: true }, { ...response, correlationId: 'other' }, { ...response, status: 'delivered' }, null]) {
    await assert.rejects(queueLocalFinalNotice(options, async () => ({ stdout: JSON.stringify(value) })), /unconfirmed/);
  }
  await assert.rejects(queueLocalFinalNotice(options, async () => { throw new Error('fixture'); }), /uncertain; do not resend/);
  await assert.rejects(queueLocalFinalNotice({ ...options, session: 'claude:broken' }, async () => { throw new Error('should not run'); }), /invalid/);
});

test('queue is followed by separately observed Claude transcript evidence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'notice-route-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(project);
  const records = [
    { type: 'user', sessionId: id, message: { content: `[HANDOVER:${nonce}] synthetic request` } },
    { type: 'assistant', sessionId: id, message: { id: 'response-1', stop_reason: 'end_turn', content: [{ type: 'text', text: notice }] } }
  ];
  await writeFile(join(project, `${id}.jsonl`), records.map(item => JSON.stringify(item)).join('\n') + '\n', { mode: 0o600 });
  const queue = await queueLocalFinalNotice(options, async () => ({ stdout: JSON.stringify(response) }));
  const proof = await observeLocalFinalNotice({ ...options, transcriptRoot: root });
  assert.equal(proof.session, queue.session);
  assert.equal(proof.messageSha256, queue.noticeSha256);
  assert.equal(proof.nonce, queue.nonce);
});
