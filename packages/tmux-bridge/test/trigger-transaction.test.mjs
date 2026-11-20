import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileTriggers } from '../bin/trigger-transaction.mjs';

function fixture() {
  const state = new Map(['one', 'two'].map(id => [id, { target: 'codex:old', version: 'v1' }]));
  const records = []; let counter = 1, calls = 0, refuse = false, lose = false;
  const adapter = {
    read: async ({ id }) => structuredClone(state.get(id)),
    move: async ({ id, expectedTarget, expectedVersion, target, operationId }) => {
      calls++;
      if (refuse && id === 'two') return { status: 'not-applied' };
      const old = state.get(id);
      if (old.target !== expectedTarget || old.version !== expectedVersion) return { status: 'not-applied' };
      const next = { target, version: `v${++counter}`, lastOperationId: operationId };
      state.set(id, next);
      if (lose && id === 'two') throw new Error('lost response');
      return { status: 'applied', version: next.version };
    }
  };
  let reserved = false;
  const journal = { begin: async () => { if (reserved) throw new Error('transaction already reserved'); reserved = true; }, write: async receipt => records.push(structuredClone(receipt)) };
  const run = (dryRun = false) => reconcileTriggers({ triggers: ['one', 'two'].map(id => ({ kind: 'timer', id })), from: 'codex:old', to: 'codex:new', transactionId: 'fixture', adapter, journal, dryRun });
  return { state, records, run, calls: () => calls, refuse: () => { refuse = true; }, lose: () => { lose = true; } };
}

test('dry run reads sources and records plan without moving triggers', async () => {
  const f = fixture(), receipt = await f.run(true);
  assert.equal(receipt.status, 'dry-run'); assert.equal(f.calls(), 0);
  assert.equal(f.state.get('one').target, 'codex:old');
});

test('each move is recorded before invocation and verified by operation identity', async () => {
  const f = fixture(), receipt = await f.run();
  assert.equal(receipt.status, 'verified');
  assert.deepEqual(receipt.triggers.map(row => row.status), ['verified', 'verified']);
  assert.ok(f.records.some(item => item.triggers[0].status === 'applying'));
  assert.equal(f.state.get('two').target, 'codex:new');
});

test('a definite refusal rolls back earlier verified moves', async () => {
  const f = fixture(); f.refuse(); const receipt = await f.run();
  assert.equal(receipt.status, 'rolled-back');
  assert.equal(receipt.triggers[0].status, 'rolled-back');
  assert.equal(f.state.get('one').target, 'codex:old');
});

test('a lost response is uncertain and is never retried or falsely rolled back', async () => {
  const f = fixture(); f.lose(); const receipt = await f.run();
  assert.equal(receipt.status, 'uncertain'); assert.equal(f.calls(), 2);
  await assert.rejects(f.run(), /already reserved/);
  assert.equal(receipt.triggers[1].status, 'uncertain');
  assert.equal(f.state.get('one').target, 'codex:new');
});
