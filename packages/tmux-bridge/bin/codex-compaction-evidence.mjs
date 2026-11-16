#!/usr/bin/env node
/** Observe one native compaction and commit an idempotent local evidence reference. */
import { parseArgs } from 'node:util';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withCodexAppServer } from './codex-app-server.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const hash = text => createHash('sha256').update(text).digest('hex');
const here = dirname(fileURLToPath(import.meta.url));

export function compactionFromThread(response, { thread, turn, item }) {
  if (typeof thread !== 'string' || !UUID.test(thread) || typeof turn !== 'string' || !TOKEN.test(turn) || typeof item !== 'string' || !TOKEN.test(item) || response?.thread?.id !== thread || !Array.isArray(response.thread.turns)) throw new Error('native thread identity unavailable');
  const turns = response.thread.turns.filter(value => value?.id === turn);
  // The native Turn schema defaults an omitted itemsView to "full".
  if (turns.length !== 1 || (turns[0].itemsView !== undefined && turns[0].itemsView !== 'full') || !Array.isArray(turns[0].items) || !['completed', 'interrupted', 'failed', 'inProgress'].includes(turns[0].status)) throw new Error('native turn unavailable or incomplete');
  const items = turns[0].items.filter(value => value?.id === item);
  if (items.length !== 1 || items[0].type !== 'contextCompaction' || !Number.isSafeInteger(items[0].completedAtMs) || items[0].completedAtMs <= 0) throw new Error('completed compaction unavailable');
  return { schema: 'agent-mesh.codex-compaction-evidence.v1', source: 'codex-app-server.thread-read', session: `codex:${thread}`, turn, item, completedAtMs: items[0].completedAtMs };
}

async function privateRoot(root) {
  if (!isAbsolute(root)) throw new Error('invalid evidence root');
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || await realpath(root) !== root) throw new Error('evidence root must be private and canonical');
}

async function persistEvidence(root, body) {
  await privateRoot(root);
  const digest = hash(body), path = join(root, `${digest}.json`);
  let file;
  try {
    file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.writeFile(body);
    await file.sync();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size !== Buffer.byteLength(body) || await file.readFile('utf8') !== body) throw new Error('existing evidence mismatch');
  } finally { if (file) await file.close(); }
  const directory = await open(root, constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
  return `codex-compaction:${digest}`;
}

/** Verify a record from the operator's trusted private evidence root. */
export async function verifyCodexCompactionEvidence({ evidenceRoot, reference, session }) {
  if (typeof reference !== 'string' || !/^codex-compaction:[a-f0-9]{64}$/.test(reference) || typeof session !== 'string' || !session.startsWith('codex:') || !UUID.test(session.slice(6))) throw new Error('invalid evidence request');
  await privateRoot(evidenceRoot);
  const path = join(evidenceRoot, `${reference.slice('codex-compaction:'.length)}.json`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let body;
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || before.size < 1 || before.size > 4096) throw new Error('invalid evidence file');
    body = await file.readFile('utf8');
    const after = await file.stat(), current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('evidence changed during verification');
  } finally { await file.close(); }
  if (`codex-compaction:${hash(body)}` !== reference) throw new Error('evidence digest mismatch');
  let value;
  try { value = JSON.parse(body); } catch { throw new Error('invalid evidence record'); }
  if (!value || Object.keys(value).sort().join(',') !== 'completedAtMs,item,schema,session,source,turn' || `${JSON.stringify(value)}\n` !== body || value.schema !== 'agent-mesh.codex-compaction-evidence.v1' || value.source !== 'codex-app-server.thread-read' || value.session !== session || typeof value.turn !== 'string' || !TOKEN.test(value.turn) || typeof value.item !== 'string' || !TOKEN.test(value.item) || !Number.isSafeInteger(value.completedAtMs) || value.completedAtMs <= 0) throw new Error('evidence identity mismatch');
  return { schema: value.schema, session, turn: value.turn, item: value.item, completedAtMs: value.completedAtMs, evidence: reference };
}

export async function recordCodexCompaction({ thread, turn, item, evidenceRoot, graphState }) {
  if (typeof thread !== 'string' || !UUID.test(thread) || typeof turn !== 'string' || !TOKEN.test(turn) || typeof item !== 'string' || !TOKEN.test(item) || typeof graphState !== 'string' || !isAbsolute(graphState)) throw new Error('invalid observation identity or graph state');
  await privateRoot(evidenceRoot);
  const response = await withCodexAppServer({ clientName: 'agent-mesh-compaction-evidence', timeout: 30000, timeoutMessage: 'native observation timed out' }, request => request('thread/read', { threadId: thread, includeTurns: true }));
  const evidence = compactionFromThread(response, { thread, turn, item });
  const reference = await persistEvidence(evidenceRoot, `${JSON.stringify(evidence)}\n`);
  const observation = `codex-compaction-${hash(JSON.stringify([thread, turn, item]))}`;
  const args = [join(here, 'mesh-graph.mjs'), '--state', graphState];
  args.push('lifecycle', 'record', '--type', 'session.compacted', '--session', evidence.session, '--id', observation, '--evidence', reference);
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
  if (result.error || result.status !== 0) throw new Error('graph recording failed; retain evidence and retry with the same identity');
  let receipt;
  try { receipt = JSON.parse(result.stdout); } catch { throw new Error('graph receipt unavailable'); }
  if (receipt?.observation !== observation || typeof receipt.duplicate !== 'boolean') throw new Error('graph receipt mismatch');
  return { schema: 'agent-mesh.compaction-record.v1', session: evidence.session, evidence: reference, duplicate: receipt.duplicate };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { values } = parseArgs({ options: { thread: { type: 'string' }, turn: { type: 'string' }, item: { type: 'string' }, verify: { type: 'string' }, session: { type: 'string' }, 'evidence-root': { type: 'string' }, 'graph-state': { type: 'string' } }, strict: true });
    if (values.verify !== undefined) {
      if (values.thread || values.turn || values.item || values['graph-state']) throw new Error('invalid verify options');
      console.log(JSON.stringify(await verifyCodexCompactionEvidence({ evidenceRoot: values['evidence-root'], reference: values.verify, session: values.session })));
    } else {
      if (values.session) throw new Error('invalid record options');
      console.log(JSON.stringify(await recordCodexCompaction({ thread: values.thread, turn: values.turn, item: values.item, evidenceRoot: values['evidence-root'], graphState: values['graph-state'] })));
    }
  } catch { console.error('compaction observation or recording failed; inspect locally before retry'); process.exitCode = 1; }
}
