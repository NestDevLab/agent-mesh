import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { roleProfileDigest } from '../bin/restart-state.mjs';
import { prepareState, requestStateProof, verifyStateResponse, revalidateStateProof } from '../bin/handover-state-proof.mjs';
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
  const prepared = { status: 'verified', session, generation: 1, id: nonce, filename, sha256: response.sha256, bytes: Buffer.byteLength(content) };
  const revalidate = (overrides = {}) => revalidateStateProof({ root, channel, session, generation: 1, statePreparation: prepared, ...overrides });
  assert.equal((await revalidate()).sha256, response.sha256);
  const profile = { schema: 'agent-mesh.role-profile.v1', role: 'operator', permissions: [], mcp: [], plugins: [] };
  assert.equal((await revalidate()).profileSha256, roleProfileDigest(profile));
  assert.notEqual(roleProfileDigest(profile), roleProfileDigest({ ...profile, mcp: ['different'] }));
  assert.equal(roleProfileDigest({ ...profile, mcp: ['z', 'a'] }), roleProfileDigest({ ...profile, mcp: ['a', 'z'] }));
  await assert.rejects(revalidate({ generation: 2 }), /receipt mismatch/);
  await assert.rejects(revalidate({ statePreparation: { ...prepared, bytes: prepared.bytes + 1 } }), /size mismatch/);
  await writeFile(join(root, filename), content.replace('operator', 'operatOr'), { mode: 0o600 });
  await assert.rejects(revalidate(), /digest mismatch/);
  await writeFile(join(root, filename), content, { mode: 0o600 });
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

test('state verification rejects path replacement during YAML decoding', async t => {
  const root = await mkdtemp(join(tmpdir(), 'state-replacement-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = 'codex:22222222-2222-4222-8222-222222222222', channel = '#example', filename = 'state.yaml', nonce = 'attempt-1';
  const content = `schema: agent-mesh.restart.v1\nsession: ${session}\nchannel: '#example'\nharness: codex\nworking_directory: /workspace\nskills: []\ntriggers: []\ngoal: null\nrole_profile:\n  schema: agent-mesh.role-profile.v1\n  role: operator\n  permissions: []\n  mcp: []\n  plugins: []\n`;
  const state = join(root, filename), shim = join(root, 'decoder-shim');
  await writeFile(state, content, { mode: 0o600 });
  await writeFile(shim, '#!/bin/sh\npython3 "$@"\ncp -- "$TEST_STATE_FILE" "$TEST_STATE_FILE.swap"\nmv -- "$TEST_STATE_FILE.swap" "$TEST_STATE_FILE"\n', { mode: 0o700 });
  const oldPython = process.env.PYTHON, oldState = process.env.TEST_STATE_FILE;
  process.env.PYTHON = shim; process.env.TEST_STATE_FILE = state;
  try {
    const response = JSON.stringify({ schema: 'agent-mesh.handover-state.v1', session, nonce, filename, sha256: createHash('sha256').update(content).digest('hex') });
    await assert.rejects(verifyStateResponse({ root, channel, session, nonce, filename, response }), /state file changed/);
  } finally {
    if (oldPython === undefined) delete process.env.PYTHON; else process.env.PYTHON = oldPython;
    if (oldState === undefined) delete process.env.TEST_STATE_FILE; else process.env.TEST_STATE_FILE = oldState;
  }
});
