import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareState, requestStateProof, verifyStateResponse } from '../bin/handover-state-proof.mjs';
import { beginHandover, completeStatePreparation, createChannel, enqueue, reserveStatePreparation } from '../bin/channel-state.mjs';

test('preparation reserves before transport, retains a lost response, and binds concurrent queue changes', async () => {
  let channel = beginHandover(createChannel('example', 'codex:old'));
  const proof = { schema: 'agent-mesh.handover-state.v1', session: 'codex:old', nonce: 'handover-1', filename: 'state.yaml', sha256: 'a'.repeat(64), bytes: 42 };
  let sends = 0;
  const reserve = () => { channel = reserveStatePreparation(channel, 'handover-1'); return { statePreparation: channel.statePreparation }; };
  const complete = value => { channel = completeStatePreparation(channel, value); return channel; };
  await assert.rejects(prepareState({ reserve, request: async () => { sends++; throw new Error('lost response'); }, complete }), /lost response/);
  assert.equal(channel.statePreparation.status, 'requested');
  await assert.rejects(prepareState({ reserve, request: async () => { sends++; return proof; }, complete }), /unresolved/);
  assert.equal(sends, 1);
  channel = beginHandover(createChannel('example', 'codex:old'));
  const result = await prepareState({ reserve, request: async pending => { assert.equal(pending.id, proof.nonce); channel = enqueue(channel, 'one', 'fixture'); return proof; }, complete });
  assert.equal(result.statePreparation.status, 'verified');
  assert.equal(result.queue[0].state, 'pending');
});

test('state proof binds correlated response to private file bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'state-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = 'codex:22222222-2222-4222-8222-222222222222', channel = '#example', filename = 'state.yaml', nonce = 'attempt-1';
  const content = `schema: agent-mesh.restart.v1\nsession: ${session}\nchannel: '#example'\nharness: codex\nworking_directory: /workspace\nskills: []\ntriggers: []\ngoal: null\nrole_profile:\n  schema: agent-mesh.role-profile.v1\n  role: operator\n  permissions: []\n  mcp: []\n  plugins: []\n`;
  await writeFile(join(root, filename), content, { mode: 0o600 });
  const response = { schema: 'agent-mesh.handover-state.v1', session, nonce, filename, sha256: createHash('sha256').update(content).digest('hex') };
  const verify = (overrides = {}) => verifyStateResponse({ session, channel, nonce, filename, root, response: JSON.stringify(response), ...overrides });
  assert.equal((await verify()).bytes, Buffer.byteLength(content));
  await assert.rejects(verify({ channel: '#other' }), /channel mismatch/);
  await assert.rejects(verify({ nonce: 'other' }), /binding/);
  const malformed = content + 'harness: other\n';
  await writeFile(join(root, filename), malformed, { mode: 0o600 });
  const malformedResponse = JSON.stringify({ ...response, sha256: createHash('sha256').update(malformed).digest('hex') });
  await assert.rejects(verify({ response: malformedResponse }), /restart YAML/);
  await writeFile(join(root, filename), 'changed', { mode: 0o600 });
  await assert.rejects(verify(), /digest/);
  await chmod(join(root, filename), 0o644);
  await assert.rejects(verify(), /invalid state file/);
  await symlink(filename, join(root, 'alias.yaml'));
  await assert.rejects(verify({ filename: 'alias.yaml', response: JSON.stringify({ ...response, filename: 'alias.yaml' }) }));
});

test('native request binds response to its own correlation without resuming', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'state-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = 'codex:22222222-2222-4222-8222-222222222222', filename = 'state.yaml';
  const fake = async (binary, argv, options) => {
    assert.equal(binary, process.execPath);
    assert.ok(argv.includes('--no-resume'));
    assert.ok(argv.includes('--message-stdin'));
    assert.ok(!argv.some(value => value.includes(root)));
    assert.ok(options.input.includes(join(root, filename)));
    const nonce = argv[argv.indexOf('--correlation-id') + 1];
    const content = `schema: agent-mesh.restart.v1\nsession: ${session}\nchannel: '#example'\nharness: codex\nworking_directory: /workspace\nskills: []\ntriggers: []\ngoal: null\nrole_profile:\n  schema: agent-mesh.role-profile.v1\n  role: operator\n  permissions: []\n  mcp: []\n  plugins: []\n`;
    await writeFile(join(root, filename), content, { mode: 0o600 });
    return { stdout: JSON.stringify({ schema: 'agent-mesh.handover-state.v1', session, nonce, filename, sha256: createHash('sha256').update(content).digest('hex') }) };
  };
  const proof = await requestStateProof({ session, channel: '#example', root, filename }, fake);
  assert.equal(proof.session, session);
  assert.ok(proof.nonce.startsWith('handover-'));
  assert.equal((await requestStateProof({ session, channel: '#example', root, filename, nonce: 'handover-fixed' }, fake)).nonce, 'handover-fixed');
  await assert.rejects(requestStateProof({ session, channel: '#example', root, filename, nonce: 'unsafe nonce' }, fake), /nonce/);
  await assert.rejects(requestStateProof({ session, channel: '#example', root, filename }, async () => ({ stdout: JSON.stringify({ status: 'held' }) })), /binding/);
  await assert.rejects(requestStateProof({ session, channel: '#example', root, filename }, async () => { throw new Error('timeout'); }), /timeout/);
});
