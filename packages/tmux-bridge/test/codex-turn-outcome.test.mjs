import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodexTurnOutcomeObserver } from '../bin/codex-turn-outcome.mjs';
const thread = '11111111-1111-4111-8111-111111111111', turn = '22222222-2222-4222-8222-222222222222';
const event = (overrides = {}) => ({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded', message: 'private fixture' }, ...overrides } } });

test('binds a quota failure arriving before the turn-start response', () => {
  const observer = createCodexTurnOutcomeObserver();
  observer.onNotification(event());
  assert.equal(observer.snapshot().status, 'unverified');
  observer.bind(thread, turn);
  assert.deepEqual(observer.snapshot(), { schema: 'agent-mesh.codex-turn-outcome-observation.v1', threadId: thread, turnId: turn, status: 'usage-limit', retry: 'not-authorized' });
  assert.ok(!JSON.stringify(observer.snapshot()).includes('private fixture'));
});

test('rejects other identities, message-only claims and inconsistent outcomes', () => {
  const observer = createCodexTurnOutcomeObserver(); observer.bind(thread, turn);
  observer.onNotification({ ...event(), params: { ...event().params, threadId: '33333333-3333-4333-8333-333333333333' } });
  observer.onNotification(event({ id: '44444444-4444-4444-8444-444444444444' }));
  assert.equal(observer.snapshot().status, 'unverified');
  observer.onNotification(event({ error: { message: 'usageLimitExceeded' } }));
  assert.equal(observer.snapshot().status, 'other-terminal');
  observer.onNotification(event());
  assert.equal(observer.snapshot().status, 'ambiguous');
  assert.throws(() => observer.bind(thread, turn));
});

test('overflow before binding does not yield a positive classification', () => {
  const observer = createCodexTurnOutcomeObserver();
  for (let i = 0; i < 129; i++) observer.onNotification(event());
  observer.bind(thread, turn);
  assert.equal(observer.snapshot().status, 'unverified');
});
