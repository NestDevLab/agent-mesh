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

export function beginDelivery(state, id, expectedSession, expectedGeneration) {
  if (state.phase !== 'active') throw new Error('handover in progress');
  if (expectedSession !== undefined && state.session !== expectedSession) throw new Error('channel recipient changed');
  if (expectedGeneration !== undefined && (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1 || state.generation !== expectedGeneration)) throw new Error('channel generation changed');
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
  if (receipt.nativeQueueId !== undefined) {
    if (!item.session.startsWith('codex:') || !identifier(receipt.nativeQueueId)) throw new Error('invalid native queue receipt');
    item.nativeQueueId = receipt.nativeQueueId;
  }
  item.state = 'accepted';
  return next;
}

export function beginHandover(state) {
  if (state.phase !== 'active') throw new Error('handover already in progress');
  const next = copy(state);
  next.phase = 'handover';
  delete next.statePreparation;
  return next;
}

// A reserved request is intentionally not retried automatically after a crash.
export function reserveStatePreparation(state, id) {
  if (state.phase !== 'handover' || state.statePreparation || !identifier(id)) throw new Error('state preparation unavailable or unresolved');
  if (state.queue.some(item => item.state === 'inflight')) throw new Error('unresolved inflight delivery');
  const next = copy(state);
  next.statePreparation = { id, session: state.session, generation: state.generation, status: 'requested' };
  return next;
}

export function completeStatePreparation(state, proof) {
  const pending = state.statePreparation;
  if (state.phase !== 'handover' || !pending || pending.status !== 'requested' || pending.session !== state.session || pending.generation !== state.generation || !proof || proof.schema !== 'agent-mesh.handover-state.v1' || proof.nonce !== pending.id || proof.session !== pending.session || !/^[0-9a-f]{64}$/.test(proof.sha256) || typeof proof.filename !== 'string' || !Number.isSafeInteger(proof.bytes) || proof.bytes < 1) throw new Error('state preparation changed or proof invalid');
  const next = copy(state);
  next.statePreparation = { ...pending, status: 'verified', filename: proof.filename, sha256: proof.sha256, bytes: proof.bytes };
  return next;
}

export function finishHandover(state, session, verified) {
  if (state.phase !== 'handover' || !identifier(session) || session === state.session || verified !== true) throw new Error('unverified successor');
  if (state.statePreparation && state.statePreparation.status !== 'verified') throw new Error('state preparation unresolved');
  if (state.queue.some((item) => item.state === 'inflight')) throw new Error('unresolved inflight delivery');
  const next = copy(state);
  next.session = session;
  next.generation += 1;
  next.phase = 'active';
  return next;
}
