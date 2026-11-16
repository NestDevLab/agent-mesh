import assert from 'node:assert/strict';
import test from 'node:test';
import { acknowledge, beginDelivery, beginHandover, createChannel, enqueue, switchHandover, observeDelivery, reserveWake, reserveStatePreparation, completeStatePreparation, reserveFinalNotice, recordNoticeQueued } from '../bin/channel-state.mjs';

test('a wake reservation prevents handover and requires exact accepted queue identity', () => {
  const session = 'codex:22222222-2222-4222-8222-222222222222';
  let channel = createChannel('example', session);
  channel = beginDelivery(enqueue(channel, 'message-1', 'fixture'), 'message-1', session, 1);
  channel = acknowledge(channel, 'message-1', { status: 'accepted', messageId: 'message-1', session, generation: 1, nativeQueueId: 'queue-1' });
  assert.throws(() => reserveWake(channel, 'message-1', session, 2, 'queue-1'), /reservation/);
  assert.throws(() => reserveWake(channel, 'message-1', session, 1, 'queue-2'), /identity/);
  const reserved = reserveWake(channel, 'message-1', session, 1, 'queue-1');
  assert.throws(() => beginHandover(reserved), /wake reservation/);
  assert.throws(() => reserveWake(reserved, 'message-1', session, 1, 'queue-1'), /reservation/);
  assert.throws(() => reserveWake(beginHandover(channel), 'message-1', session, 1, 'queue-1'), /reservation/);
});

test('native queue identity is scoped to its accepted Codex delivery', () => {
  const session = 'codex:22222222-2222-4222-8222-222222222222';
  let channel = createChannel('example', session);
  channel = beginDelivery(enqueue(channel, 'message-1', 'fixture'), 'message-1', session, 1);
  const receipt = { status: 'accepted', messageId: 'message-1', session, generation: 1, nativeQueueId: 'queue-1' };
  assert.throws(() => acknowledge(channel, 'message-1', { ...receipt, nativeQueueId: '../unsafe' }), /queue receipt/);
  assert.throws(() => acknowledge(channel, 'message-1', { ...receipt, generation: 2 }), /receipt/);
  assert.equal(acknowledge(channel, 'message-1', receipt).queue[0].nativeQueueId, 'queue-1');
  let other = createChannel('other', 'claude:22222222-2222-4222-8222-222222222222');
  other = beginDelivery(enqueue(other, 'message-1', 'fixture'), 'message-1', other.session, 1);
  assert.throws(() => acknowledge(other, 'message-1', { ...receipt, session: other.session }), /queue receipt/);
});

test('state preparation reserves once and binds proof to the channel generation', () => {
  let channel = beginHandover(createChannel('example', 'codex:old'));
  channel = reserveStatePreparation(channel, 'handover-1');
  assert.throws(() => reserveStatePreparation(channel, 'handover-2'), /unresolved/);
  assert.throws(() => switchHandover(channel, 'codex:new', true), /unresolved/);
  channel = enqueue(channel, 'queued', 'fixture');
  const proof = { schema: 'agent-mesh.handover-state.v1', session: 'codex:old', nonce: 'handover-1', filename: 'state.yaml', sha256: 'a'.repeat(64), bytes: 42 };
  assert.throws(() => completeStatePreparation(channel, { ...proof, nonce: 'other' }), /invalid/);
  assert.throws(() => completeStatePreparation({ ...channel, generation: 2 }, proof), /changed/);
  assert.throws(() => completeStatePreparation({ ...channel, session: 'codex:other' }, proof), /changed/);
  channel = completeStatePreparation(channel, proof);
  assert.equal(channel.statePreparation.status, 'verified');
  assert.equal(channel.queue[0].state, 'pending');
  assert.throws(() => completeStatePreparation(channel, proof), /invalid/);
});

test('handover queues work and never reroutes an uncertain delivery', () => {
  assert.equal(createChannel('#example', 'session:one').id, '#example');
  assert.throws(() => createChannel('#', 'session:one'), /invalid/);
  let channel = createChannel('example', 'session:one');
  channel = enqueue(channel, 'message-1', 'hello');
  channel = enqueue(channel, 'message-0', 'second');
  assert.throws(() => beginDelivery(channel, 'message-0'), /first pending/);
  channel = beginDelivery(channel, 'message-1');
  assert.throws(() => beginDelivery(channel, 'message-0'), /inflight/);
  channel = beginHandover(channel);
  channel = enqueue(channel, 'message-2', 'queued');
  assert.throws(() => beginDelivery(channel, 'message-2'), /handover/);
  assert.throws(() => switchHandover(channel, 'session:two', true), /inflight/);
  assert.throws(() => acknowledge(channel, 'message-1', { status: 'accepted', messageId: 'message-1', session: 'session:two', generation: 1 }), /receipt/);
  channel = acknowledge(channel, 'message-1', { status: 'accepted', messageId: 'message-1', session: 'session:one', generation: 1 });
  assert.throws(() => switchHandover(channel, 'session:two', false), /successor/);
  channel = reserveStatePreparation(channel, 'state-1');
  channel = completeStatePreparation(channel, { schema: 'agent-mesh.handover-state.v1', session: 'session:one', nonce: 'state-1', filename: 'state.yaml', sha256: 'a'.repeat(64), bytes: 1 });
  channel = switchHandover(channel, 'session:two', true);
  channel = beginDelivery(channel, 'message-0');
  assert.equal(channel.queue[1].session, 'session:two');
  assert.equal(channel.queue[1].generation, 2);
  assert.deepEqual(enqueue(channel, 'message-2', 'queued'), channel);
  assert.throws(() => enqueue(channel, 'message-2', 'different'), /conflict/);
});

test('switch drains observed backlog before reserving a predecessor notice', () => {
  let state = beginHandover(createChannel('example', 'codex:old'));
  state = enqueue(state, 'message-1', 'fixture');
  assert.throws(() => switchHandover(state, 'codex:new', true), /state preparation/);
  state = reserveStatePreparation(state, 'state-1');
  state = completeStatePreparation(state, { schema: 'agent-mesh.handover-state.v1', session: 'codex:old', nonce: 'state-1', filename: 'state.yaml', sha256: 'b'.repeat(64), bytes: 2 });
  state = switchHandover(state, 'codex:new', true);
  assert.equal(state.phase, 'draining'); assert.equal(state.handover.predecessor, 'codex:old');
  assert.throws(() => reserveFinalNotice(state, 'handover-1', 'codex:new', 'a'.repeat(64)), /unavailable/);
  state = beginDelivery(state, 'message-1');
  state = acknowledge(state, 'message-1', { status: 'accepted', messageId: 'message-1', session: 'codex:new', generation: 2 });
  assert.throws(() => reserveFinalNotice(state, 'handover-1', 'codex:new', 'a'.repeat(64)), /unavailable/);
  const proof = { schema: 'agent-mesh.delivery-observation.v1', messageId: 'message-1', session: 'codex:new', generation: 2, evidence: 'fixture-proof' };
  assert.throws(() => observeDelivery(state, 'message-1', { ...proof, session: 'codex:old' }), /observation/);
  state = observeDelivery(state, 'message-1', proof);
  assert.throws(() => reserveFinalNotice(state, 'handover-1', 'codex:other', 'a'.repeat(64)), /unavailable/);
  state = reserveFinalNotice(state, 'handover-1', 'codex:new', 'a'.repeat(64));
  assert.equal(state.finalNotice.session, 'codex:old'); assert.equal(state.finalNotice.generation, 1);
  const receipt = { schema: 'agent-mesh.notice-queue.v1', status: 'queued-unverified', session: 'codex:old', nonce: 'handover-1', noticeSha256: 'a'.repeat(64) };
  assert.throws(() => recordNoticeQueued(state, { ...receipt, nonce: 'other' }), /reservation/);
  state = recordNoticeQueued(state, receipt);
  assert.equal(state.finalNotice.status, 'queued-unverified');
  assert.equal(state.phase, 'draining');
});
