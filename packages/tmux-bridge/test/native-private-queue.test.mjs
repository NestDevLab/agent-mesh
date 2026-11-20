import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createAppServer } from './fixtures/fake-app-server.mjs';
const bin = fileURLToPath(new URL('../bin/agent-native-call.mjs', import.meta.url));
const session = '33333333-3333-4333-8333-333333333333';

for (const badReceipt of [false, true]) {
  test(`private native queue ${badReceipt ? 'rejects mismatched' : 'accepts bound'} receipt`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'private-native-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sessions = join(root, 'sessions'); await mkdir(sessions);
    await writeFile(join(sessions, `rollout-${session}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: session } }) + '\n');
    const seen = [];
    const server = createAppServer((message, peer) => {
      if (!message.id) return;
      if (message.method === 'thread/queue/add') {
        seen.push(message);
        peer.send({ id: message.id, result: { queuedSubmission: { id: 'queue-1', clientUserMessageId: badReceipt ? 'wrong' : message.params.clientUserMessageId, input: message.params.input } } });
      } else peer.send({ id: message.id, result: {} });
    });
    const socket = join(root, 'server.sock');
    await new Promise(resolve => server.listen(socket, resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const env = { ...process.env, CODEX_SESSION_ROOT: sessions, CODEX_REMOTE_SOCK: socket, CODEX_NO_REMOTE: '', CODEX_BIN: '/not-a-real-cli', MESH_COMMS_STATE: join(root, 'comms'), AGENT_FALLBACK_STATE: join(root, 'fallback') };
    delete env.MESH_COMMS_REPLAY_FD;
    const child = spawn(process.execPath, [bin, '--agent', 'codex', '--session', session, '--correlation-id', 'fixture-1', '--message-stdin', '--no-resume', '--delivery-only', '--timeout', '3'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    child.stdin.end('private fixture');
    const code = await new Promise(resolve => child.on('close', resolve));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].params.threadId, session);
    assert.equal(seen[0].params.input[0].text, 'private fixture');
    assert.equal(seen[0].params.clientUserMessageId, 'fixture-1');
    assert.ok(!stderr.includes('private fixture'));
    if (badReceipt) { assert.notEqual(code, 0); assert.match(stderr, /uncertain/); }
    else {
      assert.equal(code, 0, stderr);
      const receipt = JSON.parse(stdout);
      assert.equal(receipt.status, 'queued');
      assert.equal(receipt.nativeQueueId, 'queue-1');
      assert.equal(receipt.sessionId, session);
      assert.equal(receipt.correlationId, 'fixture-1');
      assert.ok(!stdout.includes('private fixture'));
    }
  });
}
