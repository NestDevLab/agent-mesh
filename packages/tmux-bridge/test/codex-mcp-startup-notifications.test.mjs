import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from './fixtures/fake-app-server.mjs';
import { withCodexAppServer } from '../bin/codex-app-server.mjs';
import { createCodexMcpStartupObserver } from '../bin/codex-mcp-startup-notifications.mjs';

const id = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const event = (threadId, name, status) => ({ method: 'mcpServer/startupStatus/updated', params: { threadId, name, status } });

test('passive notifications are bound after native thread response without exposing names', () => {
  const observer = createCodexMcpStartupObserver();
  observer.onNotification(event(id, 'private-fixture', 'starting'));
  observer.onNotification(event(other, 'other-fixture', 'ready'));
  observer.bindThread(id);
  observer.onNotification(event(id, 'private-fixture', 'ready'));
  observer.onNotification(event(other, 'other-fixture', 'failed'));
  const receipt = observer.snapshot();
  assert.deepEqual(receipt.counts, { starting: 0, ready: 1, failed: 0, cancelled: 0 });
  assert.equal(receipt.completeness, 'unverified');
  assert.equal(receipt.mcpStarted, null);
  assert.equal(receipt.startupTokens, null);
  assert.ok(!JSON.stringify(receipt).includes('private-fixture'));
  assert.throws(() => observer.bindThread(other), /binding/);
});

test('missing identity and notification overflow make the sample explicitly incomplete', () => {
  const observer = createCodexMcpStartupObserver();
  observer.onNotification(event(null, 'fixture', 'ready'));
  observer.bindThread(id);
  for (let i = 0; i < 4097; i++) observer.onNotification(event(id, 'fixture', 'ready'));
  const receipt = observer.snapshot();
  assert.equal(receipt.invalidOrOverflow, true);
  assert.equal(receipt.mcpStarted, null);
});

test('existing app-server client forwards notifications without issuing an inventory request', async t => {
  const root = await mkdtemp(join(tmpdir(), 'passive-notify-'));
  const socket = join(root, 'test.sock');
  const requests = [];
  const server = createAppServer((msg, peer) => {
    if (msg.method === 'initialize') peer.send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/start') {
      requests.push(msg.method);
      peer.send(event(id, 'fixture-server', 'starting'));
      peer.send({ id: msg.id, result: { thread: { id } } });
      peer.send(event(id, 'fixture-server', 'ready'));
    } else if (msg.id !== undefined) requests.push(msg.method);
  });
  await new Promise((resolve, reject) => server.listen(socket, resolve).once('error', reject));
  const old = process.env.CODEX_REMOTE_SOCK; process.env.CODEX_REMOTE_SOCK = socket;
  t.after(async () => { if (old === undefined) delete process.env.CODEX_REMOTE_SOCK; else process.env.CODEX_REMOTE_SOCK = old; await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const observer = createCodexMcpStartupObserver();
  const receipt = await withCodexAppServer({ clientName: 'test', timeout: 3000, timeoutMessage: 'timeout', onNotification: observer.onNotification }, async request => {
    const result = await request('thread/start', { ephemeral: true });
    observer.bindThread(result.thread.id);
    await new Promise(resolve => setTimeout(resolve, 30));
    return observer.snapshot();
  });
  assert.deepEqual(requests, ['thread/start']);
  assert.equal(receipt.counts.ready, 1);
  assert.equal(receipt.mcpStarted, null);
});
