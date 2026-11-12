import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { goalDecision } from '../bin/codex-goal.mjs';
import { createAppServer } from './fixtures/fake-app-server.mjs';

const exec = promisify(execFile);
const bin = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin');
const session = '44444444-4444-4444-8444-444444444444';

test('goal decision reactivates only what the sender asked for', () => {
  assert.equal(goalDecision(undefined, {}).action, 'none');
  assert.deepEqual(goalDecision({ status: 'blocked' }, {}).params, { status: 'active' });
  assert.equal(goalDecision({ status: 'blocked' }, { resume: 'off' }).action, 'none');
  assert.equal(goalDecision({ status: 'paused' }, {}).action, 'none');
  assert.equal(goalDecision({ status: 'paused' }, { resume: 'any' }).action, 'resume');
  for (const status of ['active', 'usageLimited', 'budgetLimited', 'complete']) {
    assert.equal(goalDecision({ status }, { resume: 'any' }).action, 'none', status);
  }
  assert.deepEqual(goalDecision(undefined, { objective: 'Ship' }).params, { objective: 'Ship', status: 'active' });
  assert.equal(goalDecision({ status: 'active', objective: 'Ship' }, { objective: 'Ship' }).action, 'none');
  assert.equal(goalDecision({ status: 'complete', objective: 'Ship' }, { objective: 'Ship' }).action, 'set');
});

async function fixture(t, { goal, turn = 'completed', goalError = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mesh-goal-send-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = join(root, 'sessions');
  await mkdir(sessions);
  await writeFile(join(sessions, `rollout-${session}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: session } }) + '\n');
  const codex = join(root, 'fake-codex.mjs');
  await writeFile(codex, '#!/usr/bin/env node\n');
  await chmod(codex, 0o755);
  const state = { goal };
  const requests = [];
  const server = createAppServer((message, peer) => {
    requests.push(message);
    if (!message.id) return;
    const reply = result => peer.send({ id: message.id, result });
    if (message.method === 'thread/turns/list') reply({ data: [{ id: 'turn-goal', status: turn }] });
    else if (message.method === 'turn/steer') reply({ turnId: 'turn-goal' });
    else if (message.method === 'thread/goal/get') reply(state.goal ? { goal: state.goal } : {});
    else if (message.method === 'thread/goal/set') {
      if (goalError) return peer.send({ id: message.id, error: { code: -32600, message: 'synthetic goal failure' } });
      const { threadId, origin, ...change } = message.params;
      state.goal = { objective: 'Old objective', ...state.goal, ...change };
      reply({ goal: state.goal });
    } else reply({});
  });
  const sock = join(root, 'server.sock');
  await new Promise(resolve => server.listen(sock, resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }));
  const env = { ...process.env, HOME: root, CODEX_HOME: join(root, '.codex'), CODEX_SESSION_ROOT: sessions,
    CODEX_BIN: codex, CODEX_REMOTE_SOCK: sock, CODEX_NO_REMOTE: '', MESH_COMMS_STATE: join(root, 'comms'),
    AGENT_FALLBACK_STATE: join(root, 'fallback'), AGENT_STEER_TIMEOUT_MS: '3000', AGENT_GOAL_TIMEOUT_MS: '3000',
    CODEX_GOALS_DB: join(root, 'goals.sqlite') };
  delete env.MESH_COMMS_REPLAY_FD;
  const run = async (file, args) => {
    try { return { code: 0, ...await exec(process.execPath, [join(bin, file), ...args], { env, timeout: 10000 }) }; }
    catch (error) { return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' }; }
  };
  let sequence = 0;
  const send = (extra = []) => run('agent-native-call.mjs', ['--agent', 'codex', '--session', session,
    '--correlation-id', `goal-send-${++sequence}`, '--message', 'Synthetic go-ahead', '--timeout', '3',
    '--steer-or-queue', '--delivery-only', ...extra]);
  return { root, env, state, requests, send, run };
}

const goalSets = requests => requests.filter(r => r.method === 'thread/goal/set');

test('a steered message reactivates the blocked goal it unblocks', async t => {
  const f = await fixture(t, { goal: { objective: 'Release', status: 'blocked' }, turn: 'inProgress' });
  const result = await f.send();
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, 'steered');
  assert.deepEqual(receipt.goal, { action: 'resume', before: 'blocked', after: 'active' });
  assert.deepEqual(goalSets(f.requests).map(r => r.params), [{ threadId: session, status: 'active', origin: 'user' }]);
});

test('paused goals stay paused unless the sender asks for any', async t => {
  const f = await fixture(t, { goal: { objective: 'Release', status: 'paused' } });
  const kept = JSON.parse((await f.send()).stdout);
  assert.deepEqual(kept.goal, { action: 'none', before: 'paused', after: 'paused', reason: 'goal paused' });
  assert.equal(goalSets(f.requests).length, 0);
  const resumed = JSON.parse((await f.send(['--goal-resume', 'any'])).stdout);
  assert.equal(resumed.goal.after, 'active');
});

test('--goal sets the objective active and --goal-resume off skips the goal API', async t => {
  const f = await fixture(t);
  const set = JSON.parse((await f.send(['--goal', '  Finish the release  '])).stdout);
  assert.deepEqual(set.goal, { action: 'set', before: null, after: 'active' });
  assert.equal(f.state.goal.objective, 'Finish the release');
  const before = f.requests.length;
  const off = JSON.parse((await f.send(['--goal-resume', 'off'])).stdout);
  assert.equal(off.goal, undefined);
  assert.equal(f.requests.slice(before).some(r => r.method.startsWith('thread/goal/')), false);
});

test('a goal failure is reported without failing the accepted delivery', async t => {
  const f = await fixture(t, { goal: { objective: 'Release', status: 'blocked' }, turn: 'inProgress', goalError: true });
  const result = await f.send();
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, 'steered');
  assert.equal(receipt.goal.action, 'error');
  assert.equal(f.requests.filter(r => r.method === 'turn/steer').length, 1);
});

test('invalid goal options send nothing', async t => {
  const f = await fixture(t);
  assert.equal((await f.send(['--goal', '   '])).code, 2);
  assert.equal((await f.send(['--goal-resume', 'always'])).code, 2);
  assert.equal((await f.run('agent-native-call.mjs', ['--agent', 'claude', '--session', session, '--correlation-id', 'goal-claude',
    '--message', 'x', '--goal-resume', 'any'])).code, 2);
  assert.equal((await f.run('agent-native-call.mjs', ['--agent', 'claude', '--session', 'session_Synthetic1', '--cloud',
    '--delivery-only', '--correlation-id', 'goal-cloud', '--message', 'x', '--goal', 'Ship'])).code, 2);
  assert.deepEqual(f.requests, []);
});

function writeGoals(path, rows) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, goal_id TEXT, objective TEXT, status TEXT,
    token_budget INTEGER, tokens_used INTEGER, time_used_seconds INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER)`);
  const insert = db.prepare('INSERT INTO thread_goals VALUES (?, ?, ?, ?, NULL, 0, 0, ?, ?)');
  for (const [thread, status, minutesAgo] of rows) {
    const at = Date.now() - minutesAgo * 60_000;
    insert.run(thread, `goal-${thread}`, `Objective ${thread}`, status, at, at);
  }
  db.close();
}

test('goal-watch nudges only active goals whose turn stopped', async t => {
  const f = await fixture(t);
  writeGoals(f.env.CODEX_GOALS_DB, [[session, 'active', 45], ['blocked-thread', 'blocked', 45],
    ['paused-thread', 'paused', 45], ['fresh-thread', 'active', 2], ['done-thread', 'complete', 45]]);
  const result = await f.run('agent-goal-watch.mjs', ['--idle-minutes', '20', '--nudge', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const rows = JSON.parse(result.stdout).goals;
  assert.deepEqual(rows.map(r => [r.threadId, r.state, r.nudged]).sort(),
    [[session, 'stalled', true], ['blocked-thread', 'waiting', undefined]].sort());
  assert.deepEqual(goalSets(f.requests).map(r => r.params.threadId), [session]);
});

test('goal-watch leaves a goal with a running turn alone', async t => {
  const f = await fixture(t, { turn: 'inProgress' });
  writeGoals(f.env.CODEX_GOALS_DB, [[session, 'active', 45]]);
  const result = await f.run('agent-goal-watch.mjs', ['--nudge', '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).goals, []);
  assert.equal(goalSets(f.requests).length, 0);
});
