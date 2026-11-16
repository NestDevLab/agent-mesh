import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { compactionFromThread, verifyCodexCompactionEvidence } from '../bin/codex-compaction-evidence.mjs';
import { createAppServer } from './fixtures/fake-app-server.mjs';

const exec = promisify(execFile), thread = '22222222-2222-4222-8222-222222222222', turn = 'turn-fixture', item = 'item-fixture';
const bin = fileURLToPath(new URL('../bin/codex-compaction-evidence.mjs', import.meta.url));
const graph = fileURLToPath(new URL('../bin/mesh-graph.mjs', import.meta.url));
const response = () => ({ thread: { id: thread, turns: [{ id: turn, itemsView: 'full', items: [{ id: item, type: 'contextCompaction', completedAtMs: 123456789 }] }] } });

test('only an exact completed native compaction in a full turn is accepted', () => {
  const identity = { thread, turn, item };
  assert.equal(compactionFromThread(response(), identity).completedAtMs, 123456789);
  const missingTime = response(); missingTime.thread.turns[0].items[0].completedAtMs = null;
  const summary = response(); summary.thread.turns[0].itemsView = 'summary';
  const wrongType = response(); wrongType.thread.turns[0].items[0].type = 'agentMessage';
  const duplicate = response(); duplicate.thread.turns.push(duplicate.thread.turns[0]);
  const duplicateItem = response(); duplicateItem.thread.turns[0].items.push(duplicateItem.thread.turns[0].items[0]);
  for (const value of [missingTime, summary, wrongType, duplicate, duplicateItem, { thread: { id: 'other', turns: [] } }]) assert.throws(() => compactionFromThread(value, identity));
});

test('native read records private evidence before an idempotent graph event', async t => {
  const root = await mkdtemp(join(tmpdir(), 'compaction-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'graph'), evidence = join(root, 'evidence'), socket = join(root, 'fake.sock');
  await mkdir(state, { mode: 0o700 }); await mkdir(evidence, { mode: 0o700 });
  const call = async (...args) => JSON.parse((await exec(process.execPath, [graph, '--state', state, ...args])).stdout);
  const requests = []; let completedAtMs = 123456789;
  const server = createAppServer((request, peer) => {
    if (!request.id) return;
    if (request.method === 'thread/read') { requests.push(request); const data = response(); data.thread.turns[0].items[0].completedAtMs = completedAtMs; peer.send({ id: request.id, result: data }); }
    else peer.send({ id: request.id, result: {} });
  });
  await new Promise(resolve => server.listen(socket, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { ...process.env, CODEX_REMOTE_SOCK: socket, CODEX_NO_REMOTE: '' };
  const run = async () => JSON.parse((await exec(process.execPath, [bin, '--thread', thread, '--turn', turn, '--item', item, '--evidence-root', evidence, '--graph-state', state], { env })).stdout);
  await assert.rejects(exec(process.execPath, [bin, '--thread', thread, '--turn', turn, '--item', item, '--evidence-root', evidence], { env }));
  assert.equal(requests.length, 0, 'no native observation without an explicit graph');
  assert.deepEqual(await readdir(evidence), []);
  await assert.rejects(run());
  assert.equal((await readdir(evidence)).length, 1, 'proof remains after graph rejection');
  await call('add', '--agent', 'codex', '--tmux-target', 'fixture', '--cwd', '/synthetic', '--runtime-uuid', thread, '--json');
  await call('migrate', '--apply', '--json');
  const cursor = (await call('query', 'changes', '--input', JSON.stringify({ initial: 'head' }))).cursor;
  const first = await run(), second = await run();
  assert.equal(first.duplicate, false); assert.equal(second.duplicate, true);
  assert.equal(first.evidence, second.evidence);
  assert.deepEqual(requests.map(r => r.params), Array(3).fill({ threadId: thread, includeTurns: true }));
  const files = await readdir(evidence); assert.equal(files.length, 1);
  const saved = JSON.parse(await readFile(join(evidence, files[0]), 'utf8'));
  assert.equal(saved.session, `codex:${thread}`); assert.equal(saved.completedAtMs, 123456789);
  const verified = await verifyCodexCompactionEvidence({ evidenceRoot: evidence, reference: first.evidence, session: `codex:${thread}` });
  assert.equal(verified.completedAtMs, 123456789);
  const cliVerified = JSON.parse((await exec(process.execPath, [bin, '--verify', first.evidence, '--session', `codex:${thread}`, '--evidence-root', evidence], { env })).stdout);
  assert.equal(cliVerified.completedAtMs, 123456789);
  assert.equal(requests.length, 3, 'verification does not contact the native app server');
  await assert.rejects(verifyCodexCompactionEvidence({ evidenceRoot: evidence, reference: first.evidence, session: 'codex:33333333-3333-4333-8333-333333333333' }), /identity/);
  const feed = await call('query', 'changes', '--input', JSON.stringify({ sinceCursor: cursor }));
  assert.deepEqual(feed.events.filter(e => e.type === 'session.compacted').map(e => e.evidence), [first.evidence]);
  completedAtMs += 1;
  await assert.rejects(run(), /compaction observation or recording failed/);
  const afterConflict = await call('query', 'changes', '--input', JSON.stringify({ sinceCursor: cursor }));
  assert.equal(afterConflict.events.filter(e => e.type === 'session.compacted').length, 1);
  const evidenceFile = join(evidence, files[0]);
  await chmod(evidenceFile, 0o644);
  await assert.rejects(verifyCodexCompactionEvidence({ evidenceRoot: evidence, reference: first.evidence, session: `codex:${thread}` }), /invalid evidence file/);
  await chmod(evidenceFile, 0o600);
  await writeFile(evidenceFile, JSON.stringify({ ...saved, completedAtMs: 123456780 }) + '\n');
  await assert.rejects(verifyCodexCompactionEvidence({ evidenceRoot: evidence, reference: first.evidence, session: `codex:${thread}` }), /digest/);
});
