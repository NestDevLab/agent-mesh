import assert from 'node:assert/strict';
import test from 'node:test';
import { invokeReservedSuccessor } from '../bin/successor-launch-controller.mjs';
const binding = { handoverId: 'handover-1', launchId: 'launch-1', session: 'codex:old', generation: 1, profileSha256: 'a'.repeat(64), stateSha256: 'b'.repeat(64) };
const preflight = async b => ({ schema: 'agent-mesh.successor-preflight.v1', status: 'ready', ...b, approvalPolicy: 'never', policyVerified: true, roleProfileVerified: true, mcpPreflightComplete: true, pluginPlanVerified: true, mcpChecked: 0 });
const channel = b => ({ phase: 'handover', handoverId: b.handoverId, session: b.session, generation: b.generation, successorLaunch: { id: b.launchId, handoverId: b.handoverId, session: b.session, generation: b.generation, profileSha256: b.profileSha256, stateSha256: b.stateSha256, status: 'invoking' } });

test('launch occurs only after matching preflight and durable checkpoint', async () => {
  const order = [];
  const result = await invokeReservedSuccessor({ binding, preflight: async b => { order.push('preflight'); return preflight(b); }, markInvoking: async b => { order.push('mark'); return { channel: channel(b) }; }, launch: async () => { order.push('launch'); } });
  assert.deepEqual(order, ['preflight', 'mark', 'launch']);
  assert.equal(result.status, 'outcome-unverified');
});

test('missing evidence or a changed checkpoint never invokes the launcher', async () => {
  let marks = 0, launches = 0;
  const launch = async () => { launches++; };
  await assert.rejects(invokeReservedSuccessor({ binding, preflight: async b => ({ ...await preflight(b), mcpPreflightComplete: false }), markInvoking: async () => { marks++; }, launch }), /preflight/);
  await assert.rejects(invokeReservedSuccessor({ binding, preflight: async b => ({ ...await preflight(b), approvalPolicy: 'on-request' }), markInvoking: async () => { marks++; }, launch }), /preflight/);
  assert.equal(marks, 0);
  await assert.rejects(invokeReservedSuccessor({ binding, preflight, markInvoking: async b => ({ channel: { ...channel(b), generation: 2 } }), launch }), /checkpoint/);
  await assert.rejects(invokeReservedSuccessor({ binding, preflight, markInvoking: async () => { throw Error('conflict'); }, launch }), /conflict/);
  assert.equal(launches, 0);
});

test('an uncertain launch is attempted once and never marked successful', async () => {
  let calls = 0;
  const result = await invokeReservedSuccessor({ binding, preflight, markInvoking: async b => ({ channel: channel(b) }), launch: async () => { calls++; throw Error('lost reply'); } });
  assert.equal(result.status, 'outcome-uncertain'); assert.equal(calls, 1);
});

test('a checkpoint for another successor never invokes the launcher', async () => {
  const bound = { ...binding, successorSession: 'claude:33333333-3333-4333-8333-333333333333' };
  let calls = 0;
  await assert.rejects(invokeReservedSuccessor({ binding: bound, preflight, markInvoking: async b => ({ channel: { ...channel(b), successorLaunch: { ...channel(b).successorLaunch, successorSession: 'claude:44444444-4444-4444-8444-444444444444' } } }), launch: async () => { calls++; } }), /checkpoint/);
  assert.equal(calls, 0);
});
