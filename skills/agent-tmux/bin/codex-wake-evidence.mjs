#!/usr/bin/env node
/** Explicitly start one queued waker turn and record private native evidence. */
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { withCodexAppServer } from './codex-app-server.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const here = dirname(fileURLToPath(import.meta.url));

async function privateRoot(root) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('invalid evidence root');
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || await realpath(root) !== root) throw new Error('evidence root must be private and canonical');
}

async function createDurable(root, name, body) {
  const fd = await open(join(root, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await fd.writeFile(body); await fd.sync(); } finally { await fd.close(); }
  const directory = await open(root, constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function readIntent(root, session, queueId, correlation) {
  const path = join(root, `intent-${hash(JSON.stringify([session, queueId]))}.json`);
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.uid !== process.getuid() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || before.size < 1 || before.size > 4096) throw new Error('invalid intent');
    const body = await fd.readFile('utf8'), after = await fd.stat(), current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || body !== `${JSON.stringify({ schema: 'agent-mesh.codex-wake-intent.v1', session, queueId, correlation })}\n`) throw new Error('intent mismatch');
  } finally { await fd.close(); }
}

// Reconcile only from a completed readback; never start or resume a thread.
export async function reconcileCodexWake({ channel, graphState, evidenceRoot, apply }) {
  if (apply !== true || typeof channel !== 'string' || !/^#?[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(channel) || typeof graphState !== 'string' || !isAbsolute(graphState)) throw new Error('explicit recovery scope required');
  await privateRoot(graphState); await privateRoot(evidenceRoot);
  const result = spawnSync(process.execPath, [join(here, 'mesh-graph.mjs'), '--state', graphState, 'channel', 'get', '--name', channel], { encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
  let state; try { state = JSON.parse(result.stdout)?.channel; } catch { throw new Error('channel unavailable'); }
  const reservation = state?.wakeReservation;
  if (result.error || result.status !== 0 || !['active', 'draining'].includes(state?.phase) || !reservation || reservation.mode === 'auto-readback' || state.session !== reservation.session || state.generation !== reservation.generation || typeof reservation.session !== 'string' || !reservation.session.startsWith('codex:') || !UUID.test(reservation.session.slice(6)) || typeof reservation.id !== 'string' || !reservation.id.startsWith('waker-') || !UUID.test(reservation.id.slice(6)) || typeof reservation.nativeQueueId !== 'string' || !TOKEN.test(reservation.nativeQueueId)) throw new Error('wake reservation unavailable');
  const { session, id: correlation, nativeQueueId: queueId, generation } = reservation;
  const items = state.queue.filter(item => item.id === correlation && item.session === session && item.generation === generation && item.nativeQueueId === queueId && item.state === 'accepted' && typeof item.payload === 'string');
  if (items.length !== 1) throw new Error('wake item unavailable');
  await readIntent(evidenceRoot, session, queueId, correlation);
  const thread = session.slice(6);
  const observed = await withCodexAppServer({ clientName: 'agent-mesh-wake-reconcile', timeout: 30000, timeoutMessage: 'native read unavailable' }, request => request('thread/read', { threadId: thread, includeTurns: true }));
  if (observed?.thread?.id !== thread || !Array.isArray(observed.thread.turns)) throw new Error('native read unavailable');
  const matching = [];
  for (const turn of observed.thread.turns) {
    if (!Array.isArray(turn.items) || (turn.itemsView !== undefined && turn.itemsView !== 'full')) throw new Error('incomplete native read');
    for (const item of turn.items) if (item?.type === 'userMessage' && item.clientId === correlation) matching.push({ turn, item });
  }
  const candidate = matching[0];
  if (matching.length !== 1 || typeof candidate.turn.id !== 'string' || !UUID.test(candidate.turn.id) || !Number.isSafeInteger(candidate.turn.startedAt) || candidate.turn.startedAt <= 0 || !['inProgress', 'completed', 'failed', 'interrupted'].includes(candidate.turn.status) || JSON.stringify(candidate.item.content) !== JSON.stringify([{ type: 'text', text: items[0].payload, text_elements: [] }])) throw new Error('wake readback not uniquely verified');
  const evidence = state.phase === 'draining'
    ? { schema: 'agent-mesh.codex-wake-evidence.v4', source: 'codex-app-server.correlated-recovery-bound', session, queueId, correlation, turn: candidate.turn.id, startedAt: candidate.turn.startedAt, channel, generation, payloadSha256: hash(items[0].payload) }
    : { schema: 'agent-mesh.codex-wake-evidence.v3', source: 'codex-app-server.correlated-recovery', session, queueId, correlation, turn: candidate.turn.id, startedAt: candidate.turn.startedAt };
  const body = `${JSON.stringify(evidence)}\n`, reference = `codex-wake:${hash(body)}`;
  try { await createDurable(evidenceRoot, `wake-${hash(body)}.json`, body); }
  catch (error) { if (error.code !== 'EEXIST') throw error; await verifyCodexWakeEvidence({ evidenceRoot, reference, session }); }
  return publishCodexWake({ evidenceRoot, reference, session, graphState, channel });
}

// Disabled: a matching client ID can also come from a steer while the queued
// submission remains pending. Readback alone cannot prove queue consumption.
export async function observeAutoCodexWake() {
  throw new Error('auto wake observation disabled: queue consumption is unproven');
}

export async function verifyCodexWakeEvidence({ evidenceRoot, reference, session }) {
  if (typeof reference !== 'string' || !/^codex-wake:[a-f0-9]{64}$/.test(reference) || typeof session !== 'string' || !session.startsWith('codex:') || !UUID.test(session.slice(6))) throw new Error('invalid wake verification request');
  await privateRoot(evidenceRoot);
  const path = join(evidenceRoot, `wake-${reference.slice('codex-wake:'.length)}.json`), file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let body;
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || before.size < 1 || before.size > 4096) throw new Error('invalid wake evidence file');
    body = await file.readFile('utf8');
    const after = await file.stat(), current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('wake evidence changed');
  } finally { await file.close(); }
  if (`codex-wake:${hash(body)}` !== reference) throw new Error('wake digest mismatch');
  let value;
  try { value = JSON.parse(body); } catch { throw new Error('invalid wake evidence'); }
  const legacy = value && Object.keys(value).sort().join(',') === 'correlation,queueId,schema,session,source,startedAt,turn' && ((value.schema === 'agent-mesh.codex-wake-evidence.v2' && value.source === 'codex-app-server.queue-start-readback') || (value.schema === 'agent-mesh.codex-wake-evidence.v3' && value.source === 'codex-app-server.correlated-recovery'));
  const bound = value && Object.keys(value).sort().join(',') === 'channel,correlation,generation,payloadSha256,queueId,schema,session,source,startedAt,turn' && value.schema === 'agent-mesh.codex-wake-evidence.v4' && ['codex-app-server.queue-start-bound-readback', 'codex-app-server.correlated-recovery-bound'].includes(value.source) && typeof value.channel === 'string' && /^#?[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.channel) && Number.isSafeInteger(value.generation) && value.generation > 0 && /^[a-f0-9]{64}$/.test(value.payloadSha256);
  if (!value || `${JSON.stringify(value)}\n` !== body || !(legacy || bound) || value.session !== session || typeof value.turn !== 'string' || !UUID.test(value.turn) || typeof value.queueId !== 'string' || !TOKEN.test(value.queueId) || typeof value.correlation !== 'string' || !value.correlation.startsWith('waker-') || !UUID.test(value.correlation.slice(6)) || !Number.isSafeInteger(value.startedAt) || value.startedAt <= 0) throw new Error('wake evidence identity mismatch');
  return { ...value, evidence: reference };
}

export async function publishCodexWake({ evidenceRoot, reference, session, graphState, channel }) {
  if (typeof graphState !== 'string' || !isAbsolute(graphState)) throw new Error('explicit graph state required');
  const proof = await verifyCodexWakeEvidence({ evidenceRoot, reference, session });
  const observation = `codex-wake-${hash(JSON.stringify([session, proof.queueId]))}`;
  const result = spawnSync(process.execPath, [join(here, 'mesh-graph.mjs'), '--state', graphState, 'lifecycle', 'record', '--type', 'session.woken', '--session', session, '--id', observation, '--evidence', reference], { encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
  if (result.error || result.status !== 0) throw new Error('graph recording failed; retain evidence for explicit publication');
  let receipt; try { receipt = JSON.parse(result.stdout); } catch { throw new Error('graph receipt unavailable'); }
  if (receipt?.observation !== observation || typeof receipt.duplicate !== 'boolean') throw new Error('graph receipt mismatch');
  if (channel !== undefined) {
    const settled = spawnSync(process.execPath, [join(here, 'mesh-graph.mjs'), '--state', graphState, 'channel', 'settle-wake', '--name', channel, '--session', session, '--state-root', evidenceRoot, '--input', reference], { encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
    if (settled.error || settled.status !== 0) throw new Error('wake settlement unavailable; retain evidence for recovery');
    let status; try { status = JSON.parse(settled.stdout); } catch { throw new Error('wake settlement receipt unavailable'); }
    const item = status?.channel?.queue?.find(row => row.id === proof.correlation && row.session === session && row.nativeQueueId === proof.queueId);
    if (item?.wakeEvidence !== reference) throw new Error('wake settlement receipt mismatch');
  }
  return { schema: 'agent-mesh.wake-record.v1', session, evidence: reference, duplicate: receipt.duplicate, ...(channel !== undefined ? { settled: true } : {}) };
}

export async function startCodexWake({ thread, queueId, correlation, channel, generation, evidenceRoot, graphState, apply }) {
  if (apply !== true || typeof thread !== 'string' || !UUID.test(thread) || typeof queueId !== 'string' || !TOKEN.test(queueId) || typeof correlation !== 'string' || !correlation.startsWith('waker-') || !UUID.test(correlation.slice(6)) || typeof channel !== 'string' || !/^#?[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(channel) || !Number.isSafeInteger(generation) || generation < 1 || typeof graphState !== 'string' || !isAbsolute(graphState)) throw new Error('explicit wake identity, channel, generation, graph and apply required');
  await privateRoot(evidenceRoot);
  await privateRoot(graphState);
  thread = thread.toLowerCase();
  const session = `codex:${thread}`;
  const result = await spawnSync(process.execPath, [join(here, 'mesh-graph.mjs'), '--state', graphState, 'show', '--json'], { encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
  let graph; try { graph = JSON.parse(result.stdout); } catch { throw new Error('graph unavailable'); }
  const matches = Array.isArray(graph.nodes) ? graph.nodes.filter(node => node.agent === 'codex' && node.runtimeUuid === thread) : [];
  if (result.error || result.status !== 0 || !graph.migrated || matches.length !== 1 || matches[0].status === 'closed' || matches[0].surface?.archived === true) throw new Error('wake session not registered or closed');
  const intent = hash(JSON.stringify([session, queueId]));
  const evidence = await withCodexAppServer({ clientName: 'agent-mesh-wake-evidence', timeout: 30000, timeoutMessage: 'native wake outcome uncertain' }, async request => {
    const listed = await request('thread/queue/list', { threadId: thread, limit: 100 });
    if (!Array.isArray(listed?.data) || listed.nextCursor != null || listed.data.filter(item => item?.id === queueId && item.clientUserMessageId === correlation && Array.isArray(item.input)).length !== 1) throw new Error('queued waker identity unavailable');
    const reserved = spawnSync(process.execPath, [join(here, 'mesh-graph.mjs'), '--state', graphState, 'channel', 'reserve-wake', '--name', channel, '--id', correlation, '--session', session, '--generation', String(generation), '--input', queueId], { encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
    if (reserved.error || reserved.status !== 0) throw new Error('wake reservation unavailable or uncertain');
    let reservedChannel; try { reservedChannel = JSON.parse(reserved.stdout)?.channel; } catch { throw new Error('wake reservation receipt unavailable'); }
    const reservation = reservedChannel?.wakeReservation;
    if (!reservation || reservation.id !== correlation || reservation.session !== session || reservation.generation !== generation || reservation.nativeQueueId !== queueId) throw new Error('wake reservation receipt mismatch');
    const queued = listed.data.find(item => item?.id === queueId && item.clientUserMessageId === correlation);
    const boundItems = Array.isArray(reservedChannel.queue) ? reservedChannel.queue.filter(item => item.id === correlation && item.session === session && item.generation === generation && item.nativeQueueId === queueId && item.state === 'accepted' && typeof item.payload === 'string') : [];
    if (reservedChannel.id !== channel || reservedChannel.session !== session || reservedChannel.generation !== generation || boundItems.length !== 1 || JSON.stringify(queued.input) !== JSON.stringify([{ type: 'text', text: boundItems[0].payload, text_elements: [] }])) throw new Error('native queue payload does not match channel reservation');
    await createDurable(evidenceRoot, `intent-${intent}.json`, `${JSON.stringify({ schema: 'agent-mesh.codex-wake-intent.v1', session, queueId, correlation })}\n`);
    const started = await request('thread/queue/start', { threadId: thread, queuedSubmissionId: queueId });
    const turn = started?.turn;
    if (!turn || typeof turn.id !== 'string' || !UUID.test(turn.id) || turn.status !== 'inProgress' || !Number.isSafeInteger(turn.startedAt) || turn.startedAt <= 0) throw new Error('native wake outcome uncertain');
    const readback = await request('thread/read', { threadId: thread, includeTurns: true });
    const observed = readback?.thread;
    const turns = Array.isArray(observed?.turns) ? observed.turns.filter(item => item?.id === turn.id) : [];
    const observedTurn = turns[0];
    const messages = Array.isArray(observedTurn?.items) ? observedTurn.items.filter(item => item?.type === 'userMessage' && item.clientId === correlation) : [];
    if (observed?.id !== thread || turns.length !== 1 || (observedTurn.itemsView !== undefined && observedTurn.itemsView !== 'full') || observedTurn.startedAt !== turn.startedAt || messages.length !== 1 || !Array.isArray(messages[0].content) || JSON.stringify(messages[0].content) !== JSON.stringify(queued.input)) throw new Error('wake readback unavailable; outcome uncertain');
    return { schema: 'agent-mesh.codex-wake-evidence.v4', source: 'codex-app-server.queue-start-bound-readback', session, queueId, correlation, turn: turn.id, startedAt: turn.startedAt, channel, generation, payloadSha256: hash(boundItems[0].payload) };
  });
  const body = `${JSON.stringify(evidence)}\n`, reference = `codex-wake:${hash(body)}`;
  await createDurable(evidenceRoot, `wake-${hash(body)}.json`, body);
  return publishCodexWake({ evidenceRoot, reference, session, graphState, channel });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { values } = parseArgs({ options: { apply: { type: 'boolean' }, reconcile: { type: 'boolean' }, 'observe-auto': { type: 'boolean' }, thread: { type: 'string' }, 'queue-id': { type: 'string' }, correlation: { type: 'string' }, channel: { type: 'string' }, generation: { type: 'string' }, 'evidence-root': { type: 'string' }, 'graph-state': { type: 'string' }, verify: { type: 'string' }, publish: { type: 'string' }, session: { type: 'string' } }, strict: true });
    if (values['observe-auto'] && (values.reconcile || values.verify || values.publish)) throw new Error('conflicting wake operations');
    let result;
    if (values['observe-auto']) result = await observeAutoCodexWake({ channel: values.channel, thread: values.thread, queueId: values['queue-id'], correlation: values.correlation, generation: /^[1-9][0-9]*$/.test(values.generation || '') ? Number(values.generation) : NaN, evidenceRoot: values['evidence-root'], graphState: values['graph-state'], apply: values.apply });
    else if (values.reconcile) result = await reconcileCodexWake({ channel: values.channel, evidenceRoot: values['evidence-root'], graphState: values['graph-state'], apply: values.apply });
    else if (values.verify) result = await verifyCodexWakeEvidence({ evidenceRoot: values['evidence-root'], reference: values.verify, session: values.session });
    else if (values.publish) result = await publishCodexWake({ evidenceRoot: values['evidence-root'], reference: values.publish, session: values.session, graphState: values['graph-state'], channel: values.channel });
    else result = await startCodexWake({ thread: values.thread, queueId: values['queue-id'], correlation: values.correlation, channel: values.channel, generation: /^[1-9][0-9]*$/.test(values.generation || '') ? Number(values.generation) : NaN, evidenceRoot: values['evidence-root'], graphState: values['graph-state'], apply: values.apply });
    console.log(JSON.stringify(result));
  } catch { console.error('wake observation failed or outcome uncertain; inspect before retry'); process.exitCode = 1; }
}
