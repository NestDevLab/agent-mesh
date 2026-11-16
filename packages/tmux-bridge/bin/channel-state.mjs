/** Pure channel transitions. A host must persist each transition atomically. */
const identifier = (value) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
const channelIdentifier = (value) => typeof value === 'string' && /^#?[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
const copy = (state) => structuredClone(state);

export function createChannel(id, session) {
  if (!channelIdentifier(id) || !identifier(session)) throw new Error('invalid channel or session');
  return { schema: 'agent-mesh.channel.v1', id, session, generation: 1, phase: 'active', queue: [] };
}

export function enqueue(state, id, payload) {
  if (!identifier(id) || typeof payload !== 'string' || !payload || Buffer.byteLength(payload) > 65536) throw new Error('invalid message');
  const prior = state.queue.find((item) => item.id === id);
  if (prior) {
    if (prior.payload !== payload) throw new Error('message id conflict');
    return copy(state);
  }
  const next = copy(state);
  next.queue.push({ id, payload, state: 'pending' });
  return next;
}

export function beginDelivery(state, id, expectedSession) {
  if (state.phase !== 'active') throw new Error('handover in progress');
  if (expectedSession !== undefined && state.session !== expectedSession) throw new Error('channel recipient changed');
  if (state.queue.some((item) => item.state === 'inflight')) throw new Error('unresolved inflight delivery');
  if (state.queue.find((item) => item.state === 'pending')?.id !== id) throw new Error('message is not first pending');
  const next = copy(state), item = next.queue.find((row) => row.id === id);
  if (!item || item.state !== 'pending') throw new Error('message not pending');
  item.state = 'inflight';
  item.session = state.session;
  item.generation = state.generation;
  return next;
}

export function acknowledge(state, id, receipt) {
  const next = copy(state), item = next.queue.find((row) => row.id === id);
  if (!item || item.state !== 'inflight' || !receipt || receipt.status !== 'accepted' || receipt.messageId !== id || receipt.session !== item.session || receipt.generation !== item.generation) throw new Error('unverified delivery receipt');
  item.state = 'accepted';
  return next;
}

export function beginHandover(state) {
  if (state.phase !== 'active') throw new Error('handover already in progress');
  const next = copy(state);
  next.phase = 'handover';
  return next;
}

export function finishHandover(state, session, verified) {
  if (state.phase !== 'handover' || !identifier(session) || session === state.session || verified !== true) throw new Error('unverified successor');
  if (state.queue.some((item) => item.state === 'inflight')) throw new Error('unresolved inflight delivery');
  const next = copy(state);
  next.session = session;
  next.generation += 1;
  next.phase = 'active';
  return next;
}
