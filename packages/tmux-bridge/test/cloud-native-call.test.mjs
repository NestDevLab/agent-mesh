import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const bin = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin');
const session = 'session_SyntheticCloud123';

async function fixture(t, mode = 'success') {
  const root = await mkdtemp(join(tmpdir(), 'mesh-cloud-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const provider = join(root, 'fake-claude.mjs');
  const calls = join(root, 'calls.jsonl');
  await writeFile(provider, `#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
let message = ''; for await (const chunk of process.stdin) message += chunk;
await appendFile(process.env.CLOUD_TEST_CALLS, JSON.stringify({ args: process.argv.slice(2), message }) + '\\n');
const mode = process.env.CLOUD_TEST_MODE;
if (mode === 'timeout') await new Promise(resolve => setTimeout(resolve, 5000));
if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 100));
if (mode === 'malformed') console.log('Sent to cloud session.');
else console.log(JSON.stringify({ ok: mode !== 'refused', session_id: mode === 'wrong-session' ? 'session_Other123' : process.argv[process.argv.indexOf('--cloud') + 1] }));
if (mode === 'nonzero') process.exitCode = 1;
`);
  await chmod(provider, 0o755);
  const env = { ...process.env, CLAUDE_BIN: provider, CLOUD_TEST_CALLS: calls, CLOUD_TEST_MODE: mode,
    MESH_COMMS_STATE: join(root, 'comms'), AGENT_FALLBACK_STATE: join(root, 'fallback') };
  // A host replay capability must never enter an isolated test invocation.
  delete env.MESH_COMMS_REPLAY_FD;
  async function command(program, args) {
    try { return { code: 0, ...await exec(program, args, { env }) }; }
    catch (error) { return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' }; }
  }
  return {
    invoke: (extra = [], message = 'Synthetic message\n--literal $(no-shell)', flags = ['--cloud', '--delivery-only']) => command(process.execPath, [join(bin, 'agent-native-call.mjs'),
      '--agent', 'claude', '--session', session, ...flags, '--correlation-id', 'synthetic-cloud-call',
      '--timeout', '1', '--message', message, ...extra]),
    gate: (action) => command('python3', [join(bin, 'mesh-comms.py'), action, '--scope', 'claude', '--reason', 'synthetic test', '--by', 'test']),
    status: () => command('python3', [join(bin, 'mesh-comms.py'), 'status']),
    calls: async () => { try { return (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } },
  };
}

test('cloud delivery verifies exact provider JSON and needs no local transcript', async t => {
  const f = await fixture(t);
  const result = await f.invoke();
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, 'queued');
  assert.equal(receipt.sessionId, session);
  assert.equal(receipt.transport, 'claude-cloud');
  assert.equal(receipt.readBack, false);
  assert.equal(receipt.responseObserved, false);
  assert.deepEqual(await f.calls(), [{ args: ['-p', '--cloud', session, '--output-format', 'json'], message: 'Synthetic message\n--literal $(no-shell)' }]);
});

test('cloud IDs require explicit delivery-only Claude routing before gate admission', async t => {
  const f = await fixture(t);
  for (const extra of [ ['--agent', 'codex'], ['--session', 'Create a new cloud session'], ['--session', 'https://claude.ai/code/session_Example'],
    ['--session', '66666666-6666-4666-8666-666666666666'], ['--resume'], ['--managed-inbox-root', '/synthetic/inbox'] ]) {
    const result = await f.invoke(extra);
    assert.equal(result.code, 2, result.stderr);
  }
  assert.equal((await f.invoke([], undefined, ['--cloud'])).code, 2);
  assert.equal((await f.invoke([], undefined, ['--delivery-only'])).code, 2);
  assert.deepEqual(await f.calls(), []);
});

test('cloud delivery accepts an explicit cse ID', async t => {
  const f = await fixture(t);
  const result = await f.invoke(['--session', 'cse_Synthetic123']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).sessionId, 'cse_Synthetic123');
});

test('concurrent cloud duplicates send once and conflicting payload is refused', async t => {
  const f = await fixture(t, 'slow');
  const results = await Promise.all([f.invoke(), f.invoke()]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal((await f.calls()).length, 1);
  assert.notEqual((await f.invoke([], 'Different payload')).code, 0);
  assert.equal((await f.calls()).length, 1);
});

for (const mode of ['refused', 'wrong-session', 'malformed', 'nonzero', 'timeout']) {
  test(`cloud ${mode} remains unknown and repeated correlation never resends`, async t => {
    const f = await fixture(t, mode);
    const result = await f.invoke();
    assert.equal(result.code, 70, result.stderr);
    assert.match(result.stderr, /inspect before retrying/);
    assert.notEqual((await f.invoke()).code, 0);
    assert.equal((await f.calls()).length, 1);
    assert.equal(JSON.parse((await f.status()).stdout).counts.unknown, 1);
  });
}

test('cloud queue is durable, replay retains exact destination and duplicate does not resend', async t => {
  const f = await fixture(t);
  assert.equal((await f.gate('queue')).code, 0);
  const queued = await f.invoke();
  assert.equal(queued.code, 0, queued.stderr);
  assert.equal(JSON.parse(queued.stdout).held, true);
  assert.deepEqual(await f.calls(), []);
  const flushed = await f.gate('on');
  assert.equal(flushed.code, 0, flushed.stderr);
  assert.equal(JSON.parse(flushed.stdout).counts.delivered, 1);
  assert.equal((await f.calls()).length, 1);
  assert.equal((await f.invoke()).code, 0);
  assert.equal((await f.calls()).length, 1);
});

test('cloud off gate never invokes provider', async t => {
  const f = await fixture(t);
  assert.equal((await f.gate('off')).code, 0);
  assert.notEqual((await f.invoke()).code, 0);
  assert.deepEqual(await f.calls(), []);
});
