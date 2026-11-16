/** Pure channel transitions. A host must persist each transition atomically. */
import { createHash } from 'node:crypto';
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
  if (!['active', 'draining'].includes(state.phase)) throw new Error('handover in progress');
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
  if (state.wakeReservation) throw new Error('wake reservation unresolved');
  const next = copy(state);
  next.phase = 'handover';
  delete next.statePreparation;
  return next;
}

// A reservation is durable and has no expiry: a crashed native call is unknown.
export function reserveWake(state, id, session, generation, nativeQueueId, mode = 'start') {
  if (!['start', 'auto-readback'].includes(mode) || !['active', 'draining'].includes(state.phase) || state.wakeReservation || state.session !== session || state.generation !== generation || !Number.isSafeInteger(generation) || generation < 1 || !identifier(nativeQueueId)) throw new Error('wake reservation unavailable');
  const matches = state.queue.filter(item => item.id === id && item.state === 'accepted' && !item.wakeEvidence && item.session === session && item.generation === generation && item.nativeQueueId === nativeQueueId);
  if (matches.length !== 1 || !session.startsWith('codex:')) throw new Error('wake identity unavailable');
  const next = copy(state);
  next.wakeReservation = { id, session, generation, nativeQueueId, mode };
  return next;
}

export function settleWake(state, proof) {
  const reservation = state.wakeReservation;
  if (!reservation || (proof?.source === 'codex-app-server.auto-start-bound-readback' ? reservation.mode !== 'auto-readback' : reservation.mode === 'auto-readback') || !['active', 'draining'].includes(state.phase) || state.session !== reservation.session || state.generation !== reservation.generation || !proof || proof.session !== reservation.session || proof.correlation !== reservation.id || proof.queueId !== reservation.nativeQueueId || !/^codex-wake:[a-f0-9]{64}$/.test(proof.evidence || '')) throw new Error('wake proof does not match reservation');
  const next = copy(state), item = next.queue.find(row => row.id === reservation.id && row.session === reservation.session && row.generation === reservation.generation && row.nativeQueueId === reservation.nativeQueueId && row.state === 'accepted' && !row.wakeEvidence);
  if (!item) throw new Error('wake item unavailable');
  item.wakeEvidence = proof.evidence;
  const boundWake = proof.schema === 'agent-mesh.codex-wake-evidence.v4' && ['codex-app-server.queue-start-bound-readback', 'codex-app-server.correlated-recovery-bound'].includes(proof.source);
  const autoWake = proof.schema === 'agent-mesh.codex-wake-evidence.v5' && proof.source === 'codex-app-server.auto-start-bound-readback' && proof.dispatchReservedAtMs === item.dispatchReservedAtMs;
  if (state.phase === 'draining' && state.handover?.backlog.includes(item.id) && (boundWake || autoWake) && proof.channel === state.id && proof.generation === item.generation && proof.payloadSha256 === createHash('sha256').update(item.payload).digest('hex')) {
    item.state = 'observed'; item.observation = proof.evidence;
  }
  delete next.wakeReservation;
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

// The durable reservation survives crashes; only authenticated evidence can
// settle it. It does not itself verify the successor or send a notice.
export function reserveFinalNotice(state, id, successor, noticeSha256) {
  const handover = state.handover;
  if (state.phase !== 'draining' || !handover || state.finalNotice || successor !== state.session || handover.successor !== successor || !identifier(id) || !/^[a-f0-9]{64}$/.test(noticeSha256 || '') || handover.backlog.some(id => !state.queue.some(item => item.id === id && item.state === 'observed' && item.session === successor && item.generation === state.generation))) throw new Error('final notice reservation unavailable');
  const next = copy(state);
  next.finalNotice = { id, session: handover.predecessor, generation: handover.previousGeneration, successor, noticeSha256, status: 'requested' };
  return next;
}

export function recordNoticeQueued(state, receipt) {
  const pending = state.finalNotice;
  if (state.phase !== 'draining' || !pending || pending.status !== 'requested' || pending.session !== state.handover?.predecessor || pending.generation !== state.handover?.previousGeneration || !receipt || receipt.schema !== 'agent-mesh.notice-queue.v1' || receipt.status !== 'queued-unverified' || receipt.session !== pending.session || receipt.nonce !== pending.id || receipt.noticeSha256 !== pending.noticeSha256) throw new Error('notice queue receipt does not match reservation');
  const next = copy(state);
  next.finalNotice.status = 'queued-unverified';
  return next;
}

// A transcript snapshot is evidence of a completed message at read time,
// not exclusive finality and not authorization to finish a handover.
export function recordNoticeObservation(state, proof) {
  const pending = state.finalNotice;
  if (state.phase !== 'draining' || !pending || !['requested', 'queued-unverified'].includes(pending.status) || pending.session !== state.handover?.predecessor || pending.generation !== state.handover?.previousGeneration || !proof || proof.schema !== 'agent-mesh.final-notice-observation.v1' || proof.session !== pending.session || proof.nonce !== pending.id || proof.messageSha256 !== pending.noticeSha256 || !/^[a-f0-9]{64}$/.test(proof.transcriptSha256 || '') || !Number.isSafeInteger(proof.bytes) || proof.bytes < 1) throw new Error('notice observation does not match reservation');
  const next = copy(state);
  next.finalNotice = { ...pending, status: 'observed-snapshot', transcriptSha256: proof.transcriptSha256, transcriptBytes: proof.bytes };
  return next;
}

// These are pure transitions. The host must independently authenticate the successor
// and delivery evidence before applying them; the operational cutover stays disabled.
export function switchHandover(state, session, verified) {
  if (state.phase !== 'handover' || !identifier(session) || session === state.session || verified !== true) throw new Error('unverified successor');
  if (state.finalNotice || state.queue.some(item => item.state === 'inflight')) throw new Error('unresolved inflight delivery or notice');
  if (state.statePreparation?.status !== 'verified' || state.statePreparation.session !== state.session || state.statePreparation.generation !== state.generation) throw new Error('state preparation unresolved');
  const next = copy(state);
  next.handover = { predecessor: state.session, previousGeneration: state.generation, successor: session, backlog: state.queue.filter(item => item.state === 'pending').map(item => item.id) };
  next.session = session;
  next.generation += 1;
  next.phase = 'draining';
  return next;
}

// An accepted provider queue receipt is not proof of recipient observation.
export function observeDelivery(state, id, proof) {
  const item = state.queue.find(row => row.id === id);
  if (state.phase !== 'draining' || !state.handover?.backlog.includes(id) || !item || item.state !== 'accepted' || item.session !== state.session || item.generation !== state.generation || !proof || proof.schema !== 'agent-mesh.delivery-observation.v1' || proof.messageId !== id || proof.session !== item.session || proof.generation !== item.generation || typeof proof.evidence !== 'string' || !identifier(proof.evidence)) throw new Error('delivery observation does not match backlog');
  const next = copy(state), observed = next.queue.find(row => row.id === id);
  observed.state = 'observed'; observed.observation = proof.evidence;
  return next;
}
