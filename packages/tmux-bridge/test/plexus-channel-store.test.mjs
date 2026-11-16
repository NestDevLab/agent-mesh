import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
const exec = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/mesh-graph.mjs', import.meta.url));

test('channel and queued messages survive concurrent writers, replay and compaction', async (t) => {
  const state = await mkdtemp(join(tmpdir(), 'channel-store-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const call = async (...args) => JSON.parse((await exec(process.execPath, [bin, '--state', state, ...args])).stdout);
  const uuid = '22222222-2222-4222-8222-222222222222';
  await call('add', '--agent', 'codex', '--tmux-target', 'fixture', '--cwd', '/synthetic', '--runtime-uuid', uuid, '--json');
  await call('migrate', '--apply', '--json');
  await call('channel', 'create', '--name', 'example', '--session', `codex:${uuid}`);
  await call('channel', 'begin-handover', '--name', 'example');
  await Promise.all(['one', 'two'].map(id => call('channel', 'enqueue', '--name', 'example', '--id', id, '--input', id)));
  assert.equal((await call('channel', 'enqueue', '--name', 'example', '--id', 'one', '--input', 'one')).duplicate, true);
  await assert.rejects(call('channel', 'enqueue', '--name', 'example', '--id', 'one', '--input', 'changed'), /conflict/);
  await rm(join(state, 'checkpoint.json'));
  let channel = (await call('channel', 'get', '--name', 'example')).channel;
  assert.equal(channel.phase, 'handover');
  assert.deepEqual(channel.queue.map(row => row.id).sort(), ['one', 'two']);
  await call('compact', '--all-history', '--apply', '--json');
  await rm(join(state, 'checkpoint.json'), { force: true });
  channel = (await call('channel', 'get', '--name', 'example')).channel;
  assert.deepEqual(channel.queue.map(row => row.id).sort(), ['one', 'two']);
});

test('delivery reservation and matching receipt survive graph replay', async (t) => {
  const state = await mkdtemp(join(tmpdir(), 'channel-delivery-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const call = async (...args) => JSON.parse((await exec(process.execPath, [bin, '--state', state, ...args])).stdout);
  const uuid = '22222222-2222-4222-8222-222222222222', session = `codex:${uuid}`;
  await call('add', '--agent', 'codex', '--tmux-target', 'fixture', '--cwd', '/synthetic', '--runtime-uuid', uuid, '--json');
  await call('migrate', '--apply', '--json');
  await call('channel', 'create', '--name', 'example', '--session', session);
  await call('channel', 'enqueue', '--name', 'example', '--id', 'one', '--input', 'payload');
  await call('channel', 'begin-delivery', '--name', 'example', '--id', 'one');
  await rm(join(state, 'checkpoint.json'));
  assert.equal((await call('channel', 'get', '--name', 'example')).channel.queue[0].state, 'inflight');
  await assert.rejects(call('channel', 'acknowledge', '--name', 'example', '--id', 'one', '--input', JSON.stringify({ status: 'accepted', messageId: 'one', session: 'codex:wrong', generation: 1 })), /receipt/);
  await call('channel', 'acknowledge', '--name', 'example', '--id', 'one', '--input', JSON.stringify({ status: 'accepted', messageId: 'one', session, generation: 1 }));
  assert.equal((await call('channel', 'get', '--name', 'example')).channel.queue[0].state, 'accepted');
});
