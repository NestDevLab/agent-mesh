import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { promisify } from 'node:util';
import { triggerJournal } from '../bin/trigger-journal.mjs';
import { reconcileTriggers } from '../bin/trigger-transaction.mjs';
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
