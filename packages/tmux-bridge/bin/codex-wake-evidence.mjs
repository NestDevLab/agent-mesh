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
  if (!value || Object.keys(value).sort().join(',') !== 'correlation,queueId,schema,session,source,startedAt,turn' || `${JSON.stringify(value)}\n` !== body || value.schema !== 'agent-mesh.codex-wake-evidence.v1' || value.source !== 'codex-app-server.queue-start' || value.session !== session || typeof value.turn !== 'string' || !UUID.test(value.turn) || typeof value.queueId !== 'string' || !TOKEN.test(value.queueId) || typeof value.correlation !== 'string' || !value.correlation.startsWith('waker-') || !UUID.test(value.correlation.slice(6)) || !Number.isSafeInteger(value.startedAt) || value.startedAt <= 0) throw new Error('wake evidence identity mismatch');
  return { ...value, evidence: reference };
}

export async function publishCodexWake({ evidenceRoot, reference, session, graphState }) {
  if (typeof graphState !== 'string' || !isAbsolute(graphState)) throw new Error('explicit graph state required');
  const proof = await verifyCodexWakeEvidence({ evidenceRoot, reference, session });
  const observation = `codex-wake-${hash(JSON.stringify([session, proof.queueId]))}`;
  const result = spawnSync(process.execPath, [join(here, 'mesh-graph.mjs'), '--state', graphState, 'lifecycle', 'record', '--type', 'session.woken', '--session', session, '--id', observation, '--evidence', reference], { encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
  if (result.error || result.status !== 0) throw new Error('graph recording failed; retain evidence for explicit publication');
  let receipt; try { receipt = JSON.parse(result.stdout); } catch { throw new Error('graph receipt unavailable'); }
  if (receipt?.observation !== observation || typeof receipt.duplicate !== 'boolean') throw new Error('graph receipt mismatch');
  return { schema: 'agent-mesh.wake-record.v1', session, evidence: reference, duplicate: receipt.duplicate };
}

export async function startCodexWake({ thread, queueId, correlation, evidenceRoot, graphState, apply }) {
  if (apply !== true || typeof thread !== 'string' || !UUID.test(thread) || typeof queueId !== 'string' || !TOKEN.test(queueId) || typeof correlation !== 'string' || !correlation.startsWith('waker-') || !UUID.test(correlation.slice(6)) || typeof graphState !== 'string' || !isAbsolute(graphState)) throw new Error('explicit wake identity, graph and apply required');
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
    await createDurable(evidenceRoot, `intent-${intent}.json`, `${JSON.stringify({ schema: 'agent-mesh.codex-wake-intent.v1', session, queueId, correlation })}\n`);
    const started = await request('thread/queue/start', { threadId: thread, queuedSubmissionId: queueId });
    const turn = started?.turn;
    if (!turn || typeof turn.id !== 'string' || !UUID.test(turn.id) || turn.status !== 'inProgress' || !Number.isSafeInteger(turn.startedAt) || turn.startedAt <= 0) throw new Error('native wake outcome uncertain');
    return { schema: 'agent-mesh.codex-wake-evidence.v1', source: 'codex-app-server.queue-start', session, queueId, correlation, turn: turn.id, startedAt: turn.startedAt };
  });
  const body = `${JSON.stringify(evidence)}\n`, reference = `codex-wake:${hash(body)}`;
  await createDurable(evidenceRoot, `wake-${hash(body)}.json`, body);
  return publishCodexWake({ evidenceRoot, reference, session, graphState });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { values } = parseArgs({ options: { apply: { type: 'boolean' }, thread: { type: 'string' }, 'queue-id': { type: 'string' }, correlation: { type: 'string' }, 'evidence-root': { type: 'string' }, 'graph-state': { type: 'string' }, verify: { type: 'string' }, publish: { type: 'string' }, session: { type: 'string' } }, strict: true });
    let result;
    if (values.verify) result = await verifyCodexWakeEvidence({ evidenceRoot: values['evidence-root'], reference: values.verify, session: values.session });
    else if (values.publish) result = await publishCodexWake({ evidenceRoot: values['evidence-root'], reference: values.publish, session: values.session, graphState: values['graph-state'] });
    else result = await startCodexWake({ thread: values.thread, queueId: values['queue-id'], correlation: values.correlation, evidenceRoot: values['evidence-root'], graphState: values['graph-state'], apply: values.apply });
    console.log(JSON.stringify(result));
  } catch { console.error('wake observation failed or outcome uncertain; inspect before retry'); process.exitCode = 1; }
}
