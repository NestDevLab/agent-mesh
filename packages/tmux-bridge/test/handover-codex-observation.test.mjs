import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { observeCodexFinalNotice } from '../bin/handover-codex-observation.mjs';

const id = '22222222-2222-4222-8222-222222222222', nonce = 'handover-44444444-4444-4444-8444-444444444444', message = 'Continue: [next](codex://threads/33333333-3333-4333-8333-333333333333)';
const line = value => JSON.stringify(value) + '\n';
const meta = () => line({ type: 'session_meta', payload: { id } });
const input = () => line({ type: 'event_msg', payload: { type: 'user_message', message: `[HANDOVER:${nonce}] Write the final notice.` } });
const output = () => line({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: message }] } });
const complete = () => line({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: message } });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'notice-observation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, `rollout-${id}.jsonl`);
  await writeFile(path, meta() + input() + output() + complete(), { mode: 0o600 });
  return { root, path, run: () => observeCodexFinalNotice({ root, id, nonce, message }) };
}
test('a correlated final Codex notice is observed without returning transcript text', async t => {
  const f = await fixture(t), result = await f.run();
  assert.equal(result.session, `codex:${id}`);
  assert.match(result.messageSha256, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(result).includes(message));
});
test('a later user turn or malformed trailing record rejects the observation', async t => {
  const f = await fixture(t);
  await appendFile(f.path, line({ type: 'event_msg', payload: { type: 'user_message', message: 'later' } }));
  await assert.rejects(f.run(), /not proven/);
  await writeFile(f.path, meta() + input() + output() + complete() + '{bad}\n');
  await assert.rejects(f.run(), /invalid transcript record/);
  await writeFile(f.path, meta() + input() + output() + complete() + '{partial');
  await assert.rejects(f.run(), /partial transcript/);
});
test('identity, exact completion, and an unambiguous native transcript are required', async t => {
  const f = await fixture(t);
  await writeFile(f.path, line({ type: 'session_meta', payload: { id: 'other' } }) + input() + output() + complete());
  await assert.rejects(f.run(), /session mismatch/);
  await writeFile(f.path, meta() + input() + output() + line({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'different' } }));
  await assert.rejects(f.run(), /not proven/);
  await writeFile(f.path, meta() + input() + output() + line({ type: 'response_item', payload: { type: 'function_call' } }) + complete());
  await assert.rejects(f.run(), /not proven/);
  await writeFile(f.path, meta() + input() + output() + complete() + line({ type: 'event_msg', payload: { type: 'task_started' } }));
  await assert.rejects(f.run(), /not proven/);
  await writeFile(f.path, meta() + input() + output() + complete());
  await writeFile(join(f.root, `duplicate-${id}.jsonl`), meta() + input() + output() + complete());
  await assert.rejects(f.run(), /ambiguous/);
});
test('a symlinked transcript is not accepted', async t => {
  const f = await fixture(t), other = join(f.root, 'unrelated');
  await writeFile(other, meta() + input() + output() + complete());
  await rm(f.path);
  await symlink(other, f.path);
  await assert.rejects(f.run(), /unavailable or ambiguous/);
});
