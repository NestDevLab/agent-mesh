import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { createAppServer } from './fixtures/fake-app-server.mjs';

const exec = promisify(execFile);
const bin = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin');
const session = '33333333-3333-4333-8333-333333333333';

async function fixture(t, mode = 'active') {
  const root = await mkdtemp(join(tmpdir(), 'mesh-steer-queue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = join(root, 'sessions');
  await mkdir(sessions);
  await writeFile(join(sessions, `rollout-${session}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: session } }) + '\n');
  const calls = join(root, 'queue-calls.jsonl');
  const codex = join(root, 'fake-codex.mjs');
  await writeFile(codex, `#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
await appendFile(process.env.SYNTHETIC_QUEUE_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
`);
  await chmod(codex, 0o755);
  const requests = [];
  const server = createAppServer(async (message, peer) => {
    requests.push(message);
    if (!message.id) return;
    if (message.method === 'thread/turns/list') {
      peer.send({ id: message.id, result: { data: [{ id: 'turn-test', status: mode === 'idle' ? 'completed' : 'inProgress' }] } });
    } else if (message.method === 'turn/steer') {
      if (mode === 'timeout') return;
      if (mode === 'error') peer.send({ id: message.id, error: { code: -32600, message: 'synthetic steer failure' } });
      else {
        if (mode.startsWith('reply-')) {
          const prompt = message.params.input[0].text;
          const token = prompt.match(/\[MESH:([a-f0-9]+)\]/)?.[1];
          const records = [
            { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Earlier turn result' }] } },
            { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'earlier-turn' } },
          ];
          if (mode !== 'reply-no-anchor') records.push(mode === 'reply-event'
            ? { type: 'event_msg', payload: { type: 'user_message', message: prompt } }
            : { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } });
          if (mode !== 'reply-stale-only') records.push(
            { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: `[[R:${token}]]Current correlated result[[/R:${token}]]` }] } },
            { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-test' } },
          );
          await appendFile(join(sessions, `rollout-${session}.jsonl`), records.map(r => JSON.stringify(r) + '\n').join(''));
        }
        peer.send({ id: message.id, result: { turnId: mode === 'bad-ack' ? '' : 'turn-test' } });
      }
    } else peer.send({ id: message.id, result: {} });
  });
  const sock = join(root, 'server.sock');
  await new Promise(resolve => server.listen(sock, resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }));
  const env = { ...process.env, HOME: root, CODEX_HOME: join(root, '.codex'), CODEX_SESSION_ROOT: sessions,
    CODEX_BIN: codex, SYNTHETIC_QUEUE_CALLS: calls, CODEX_REMOTE_SOCK: sock, CODEX_NO_REMOTE: '',
    MESH_COMMS_STATE: join(root, 'comms'), AGENT_FALLBACK_STATE: join(root, 'fallback'), AGENT_STEER_TIMEOUT_MS: mode === 'timeout' ? '300' : '3000' };
  delete env.MESH_COMMS_REPLAY_FD;
  async function run(command, args) {
    try { return { code: 0, ...await exec(command, args, { env, timeout: 10000 }) }; }
    catch (error) { return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' }; }
  }
  return {
    requests,
    invoke: ({ message = 'Synthetic response', extra = [], flags = ['--steer-or-queue', '--delivery-only'] } = {}) => run(process.execPath,
      [join(bin, 'agent-native-call.mjs'), '--agent', 'codex', '--session', session, '--correlation-id', 'return-test',
        '--message', message, '--timeout', '3', ...flags, ...extra]),
    gate: action => run('python3', [join(bin, 'mesh-comms.py'), action, '--scope', 'codex', '--reason', 'synthetic gate', '--by', 'test']),
    queueCalls: async () => { try { return (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } },
  };
}

test('composed native response steers an active turn once under concurrent deduplication', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.invoke(), f.invoke()]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const receipt = results.map(r => JSON.parse(r.stdout)).find(r => r.status === 'steered');
  assert.equal(receipt.deliveryMethod, 'steer');
  assert.equal(receipt.turnId, 'turn-test');
  assert.equal(f.requests.filter(r => r.method === 'turn/steer').length, 1);
  assert.equal(f.requests.find(r => r.method === 'turn/steer').params.input[0].text, 'Synthetic response');
  assert.deepEqual(await f.queueCalls(), []);
  assert.notEqual((await f.invoke({ message: 'Changed response' })).code, 0);
  assert.equal(f.requests.filter(r => r.method === 'turn/steer').length, 1);
});

test('composed native response queues once only after proven no-active-turn and preserves resume', async t => {
  const f = await fixture(t, 'idle');
  const result = await f.invoke({ extra: ['--resume'] });
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, 'queued');
  assert.equal(receipt.deliveryMethod, 'queue');
  assert.equal(receipt.resumeVerified, false);
  assert.equal(f.requests.some(r => r.method === 'turn/steer'), false);
  assert.deepEqual(await f.queueCalls(), [['queue', '--thread', session, '--message', 'Synthetic response', '--resume']]);
  assert.equal((await f.invoke({ extra: ['--resume'] })).code, 0);
  assert.equal((await f.queueCalls()).length, 1);
});

for (const mode of ['error', 'timeout', 'bad-ack']) {
  test(`composed native ${mode} never falls back or resends`, async t => {
    const f = await fixture(t, mode);
    const result = await f.invoke();
    assert.equal(result.code, 70, result.stderr);
    assert.match(result.stderr, /inspect before retrying/);
    const before = f.requests.length;
    assert.notEqual((await f.invoke()).code, 0);
    assert.equal(f.requests.length, before);
    assert.deepEqual(await f.queueCalls(), []);
  });
}

test('held composed response retains steer preference through capability-bound replay', async t => {
  const f = await fixture(t);
  assert.equal((await f.gate('queue')).code, 0);
  const held = await f.invoke();
  assert.equal(held.code, 0, held.stderr);
  assert.equal(JSON.parse(held.stdout).held, true);
  assert.deepEqual(f.requests, []);
  const flushed = await f.gate('on');
  assert.equal(flushed.code, 0, flushed.stderr);
  assert.equal(JSON.parse(flushed.stdout).counts.delivered, 1);
  assert.equal(f.requests.filter(r => r.method === 'turn/steer').length, 1);
  assert.equal((await f.invoke()).code, 0);
  assert.equal(f.requests.filter(r => r.method === 'turn/steer').length, 1);
  assert.deepEqual(await f.queueCalls(), []);
});

test('off and invalid composed modes send nothing', async t => {
  const f = await fixture(t);
  assert.equal((await f.invoke({ extra: ['--agent', 'claude'] })).code, 2);
  assert.equal((await f.invoke({ extra: ['--cloud'] })).code, 2);
  assert.equal((await f.gate('off')).code, 0);
  assert.notEqual((await f.invoke()).code, 0);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(await f.queueCalls(), []);
});

for (const mode of ['reply-response', 'reply-event']) {
  test(`urgent result follows the steered anchor in the running turn (${mode})`, async t => {
    const f = await fixture(t, mode);
    const result = await f.invoke({ flags: ['--steer-or-queue'] });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'Current correlated result');
    assert.deepEqual(await f.queueCalls(), []);
    assert.equal(f.requests.filter(r => r.method === 'turn/steer').length, 1);
    assert.match(f.requests.find(r => r.method === 'turn/steer').params.input[0].text, /Final result markers:/);
  });
}
for (const mode of ['active', 'reply-no-anchor', 'reply-stale-only']) {
  test(`accepted steer times out without resending or consuming an earlier final (${mode})`, async t => {
    const f = await fixture(t, mode);
    const result = await f.invoke({ flags: ['--steer-or-queue'] });
    assert.equal(result.code, 124, result.stderr);
    assert.match(result.stderr, /result collection timed out/);
    assert.deepEqual(await f.queueCalls(), []);
    const before = f.requests.length;
    await f.invoke({ flags: ['--steer-or-queue'] });
    assert.equal(f.requests.length, before);
  });
}
