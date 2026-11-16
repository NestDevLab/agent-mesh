import assert from 'node:assert/strict';
import test from 'node:test';
import { acknowledge, beginDelivery, beginHandover, createChannel, enqueue, finishHandover } from '../bin/channel-state.mjs';

test('handover queues work and never reroutes an uncertain delivery', () => {
  let channel = createChannel('example', 'session:one');
  channel = enqueue(channel, 'message-1', 'hello');
  channel = beginDelivery(channel, 'message-1');
  channel = beginHandover(channel);
  channel = enqueue(channel, 'message-2', 'queued');
  assert.throws(() => beginDelivery(channel, 'message-2'), /handover/);
  assert.throws(() => finishHandover(channel, 'session:two', true), /inflight/);
  assert.throws(() => acknowledge(channel, 'message-1', { status: 'accepted', messageId: 'message-1', session: 'session:two', generation: 1 }), /receipt/);
  channel = acknowledge(channel, 'message-1', { status: 'accepted', messageId: 'message-1', session: 'session:one', generation: 1 });
  assert.throws(() => finishHandover(channel, 'session:two', false), /successor/);
  channel = finishHandover(channel, 'session:two', true);
  channel = beginDelivery(channel, 'message-2');
  assert.equal(channel.queue[1].session, 'session:two');
  assert.equal(channel.queue[1].generation, 2);
  assert.deepEqual(enqueue(channel, 'message-2', 'queued'), channel);
  assert.throws(() => enqueue(channel, 'message-2', 'different'), /conflict/);
});
