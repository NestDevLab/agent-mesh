import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { promisify } from 'node:util';
import { triggerJournal } from '../bin/trigger-journal.mjs';
import { reconcileTriggers, recoverUncertainTriggers } from '../bin/trigger-transaction.mjs';
const exec = promisify(execFile);

test('concurrent processes cannot reserve the same trigger', async t => {
  const root = await mkdtemp(join(tmpdir(), 'trigger-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleUrl = new URL('../bin/trigger-journal.mjs', import.meta.url).href;
  const script = `import { triggerJournal } from ${JSON.stringify(moduleUrl)}; await triggerJournal(process.argv[1]).begin({id: process.argv[2], triggers:[{kind:'timer',id:'one'}], dryRun:false});`;
  const results = await Promise.allSettled(['first', 'second'].map(id => exec(process.execPath, ['--input-type=module', '-e', script, root, id])));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.match(rejected.reason.stderr, /overlapping transaction unresolved|journal lock held/);
});

test('uncertain move remains reserved after journal re-open', async t => {
  const root = await mkdtemp(join(tmpdir(), 'trigger-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trigger = { kind: 'timer', id: 'one' }, journal = triggerJournal(root);
  let calls = 0;
  const adapter = { read: async () => ({ target: 'codex:old', version: 'v1' }), move: async () => { calls++; throw new Error('lost'); } };
  const receipt = await reconcileTriggers({ triggers: [trigger], from: 'codex:old', to: 'codex:new', transactionId: 'first', adapter, journal, dryRun: false });
  assert.equal(receipt.status, 'uncertain'); assert.equal(calls, 1);
  const reopened = triggerJournal(root);
  assert.equal((await reopened.get('first')).status, 'uncertain');
  await assert.rejects(reopened.begin({ id: 'second', triggers: [trigger], dryRun: false }), /overlapping/);
  await assert.rejects(reopened.begin({ id: 'first', triggers: [trigger], dryRun: false }), /already reserved/);
  assert.equal(calls, 1);
});

test('explicit recovery rolls back only a proven move after a lost response', async t => {
  const root = await mkdtemp(join(tmpdir(), 'trigger-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let state = { target: 'codex:old', version: 'v1' }, lose = true, calls = 0;
  const adapter = { read: async () => structuredClone(state), move: async args => {
    calls++;
    if (state.target !== args.expectedTarget || state.version !== args.expectedVersion) return { status: 'not-applied' };
    state = { target: args.target, version: `v${calls + 1}`, lastOperationId: args.operationId };
    if (lose) { lose = false; throw new Error('response lost'); }
    return { status: 'applied', version: state.version };
  } };
  const journal = triggerJournal(root), triggers = [{ kind: 'timer', id: 'one' }];
  const first = await reconcileTriggers({ triggers, from: 'codex:old', to: 'codex:new', transactionId: 'tx', adapter, journal, dryRun: false });
  assert.equal(first.status, 'uncertain'); assert.equal(state.target, 'codex:new');
  const recovered = await recoverUncertainTriggers({ transactionId: 'tx', adapter, journal: triggerJournal(root) });
  assert.equal(recovered.status, 'rolled-back'); assert.equal(state.target, 'codex:old'); assert.equal(calls, 2);
  assert.equal((await triggerJournal(root).get('tx')).status, 'rolled-back');
});

test('recovery refuses another writer before attempting any rollback', async t => {
  const root = await mkdtemp(join(tmpdir(), 'trigger-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let state = { target: 'codex:old', version: 'v1' }, calls = 0;
  const adapter = { read: async () => structuredClone(state), move: async args => { calls++; state = { target: args.target, version: 'v2', lastOperationId: args.operationId }; throw new Error('lost'); } };
  const journal = triggerJournal(root);
  await reconcileTriggers({ triggers: [{ kind: 'timer', id: 'one' }], from: 'codex:old', to: 'codex:new', transactionId: 'tx', adapter, journal, dryRun: false });
  state = { target: 'codex:new', version: 'v3', lastOperationId: 'other' };
  await assert.rejects(recoverUncertainTriggers({ transactionId: 'tx', adapter, journal }), /outside transaction/);
  assert.equal(calls, 1); assert.equal((await journal.get('tx')).status, 'uncertain');
});

test('recovery restores two proven moves in reverse order', async t => {
  const root = await mkdtemp(join(tmpdir(), 'trigger-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = new Map(['one', 'two'].map(id => [id, { target: 'codex:old', version: 'v1' }]));
  const operations = []; let counter = 1, lose = true;
  const adapter = { read: async ({ id }) => structuredClone(state.get(id)), move: async args => {
    const current = state.get(args.id);
    if (current.target !== args.expectedTarget || current.version !== args.expectedVersion) return { status: 'not-applied' };
    operations.push(args.operationId);
    const next = { target: args.target, version: `v${++counter}`, lastOperationId: args.operationId };
    state.set(args.id, next);
    if (args.id === 'two' && lose) { lose = false; throw new Error('response lost'); }
    return { status: 'applied', version: next.version };
  } };
  const journal = triggerJournal(root), triggers = ['one', 'two'].map(id => ({ kind: 'timer', id }));
  const uncertain = await reconcileTriggers({ triggers, from: 'codex:old', to: 'codex:new', transactionId: 'tx', adapter, journal, dryRun: false });
  assert.equal(uncertain.status, 'uncertain');
  const recovered = await recoverUncertainTriggers({ transactionId: 'tx', adapter, journal });
  assert.equal(recovered.status, 'rolled-back');
  assert.deepEqual(operations, ['tx:0', 'tx:1', 'tx:rollback:1', 'tx:rollback:0']);
  assert.equal(state.get('one').target, 'codex:old'); assert.equal(state.get('two').target, 'codex:old');
});

test('completed dry run releases scope, but not its transaction ID', async t => {
  const root = await mkdtemp(join(tmpdir(), 'trigger-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trigger = { kind: 'timer', id: 'one' }, journal = triggerJournal(root);
  const adapter = { read: async () => ({ target: 'codex:old', version: 'v1' }), move: async () => { throw new Error('must not move'); } };
  const receipt = await reconcileTriggers({ triggers: [trigger], from: 'codex:old', to: 'codex:new', transactionId: 'dry', adapter, journal });
  assert.equal(receipt.status, 'dry-run');
  await journal.begin({ id: 'next', triggers: [trigger], dryRun: false });
  await assert.rejects(journal.begin({ id: 'dry', triggers: [trigger], dryRun: false }), /already reserved/);
});

test('journal refuses unsafe permissions, invalid state and abandoned locks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'trigger-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = triggerJournal(root), reservation = { id: 'one', triggers: [], dryRun: true };
  await chmod(root, 0o755);
  await assert.rejects(journal.begin(reservation), /private/);
  await chmod(root, 0o700);
  await writeFile(join(root, 'trigger-transactions.json'), '{broken', { mode: 0o600 });
  await assert.rejects(journal.begin(reservation));
  await writeFile(join(root, '.trigger-transactions.lock'), 'fixture', { mode: 0o600 });
  await assert.rejects(journal.begin(reservation), /lock held/);
});

test('preflight read failure is durably not-applied and releases the reservation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'trigger-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const triggers = [{ kind: 'timer', id: 'one' }, { kind: 'timer', id: 'two' }];
  let moves = 0;
  const adapter = { read: async ({ id }) => { if (id === 'two') throw new Error('offline'); return { target: 'codex:old', version: 'v1' }; }, move: async () => { moves++; } };
  const journal = triggerJournal(root);
  const receipt = await reconcileTriggers({ triggers, from: 'codex:old', to: 'codex:new', transactionId: 'first', adapter, journal, dryRun: false });
  assert.equal(receipt.status, 'not-applied');
  assert.equal(receipt.triggers[1].status, 'unverified');
  assert.equal(moves, 0);
  const stored = await triggerJournal(root).get('first');
  assert.equal(stored.status, 'not-applied');
  assert.equal(stored.receipt.reason, 'trigger source or version not verified');
  await triggerJournal(root).begin({ id: 'second', triggers, dryRun: true });
});
