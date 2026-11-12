import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const script = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'agent-session-status.mjs');
const session = '44444444-4444-4444-8444-444444444444';
const now = new Date().toISOString();
const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();

async function status(t, agent, records) {
  const root = await mkdtemp(join(tmpdir(), 'mesh-session-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'nested'));
  if (records) await writeFile(join(root, 'nested', `${session}.jsonl`), records.map(JSON.stringify).join('\n') + '\n');
  const { stdout } = await exec(process.execPath, [script, '--agent', agent, '--session', session],
    { env: { ...process.env, CLAUDE_SESSION_ROOT: root, CODEX_SESSION_ROOT: root } });
  return JSON.parse(stdout);
}

const assistant = (stop, content, timestamp = now) => ({ type: 'assistant', timestamp, message: { stop_reason: stop, content } });
const todo = { type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'first', status: 'in_progress' }] } };

test('claude turn in progress is busy with its checklist and last step', async (t) => {
  const result = await status(t, 'claude', [assistant('tool_use', [todo]), assistant('tool_use', [{ type: 'tool_use', name: 'Bash', input: {} }])]);
  assert.equal(result.state, 'busy');
  assert.equal(result.last_step, 'tool: Bash');
  assert.deepEqual(result.checklist, [{ text: 'first', status: 'in_progress' }]);
});

test('claude finished turn is free and hides the old checklist', async (t) => {
  const result = await status(t, 'claude', [assistant('tool_use', [todo]), assistant('end_turn', [{ type: 'text', text: 'done\nmore' }])]);
  assert.equal(result.state, 'free');
  assert.equal(result.last_step, 'done');
  assert.deepEqual(result.checklist, []);
});

test('claude interrupted turn is free, sidechains are ignored', async (t) => {
  const result = await status(t, 'claude', [
    { type: 'user', timestamp: now, message: { content: '[Request interrupted by user]' } },
    { ...assistant('tool_use', []), isSidechain: true }
  ]);
  assert.equal(result.state, 'free');
});

test('local commands and stop sequences do not read as an open turn', async (t) => {
  const done = assistant('end_turn', [{ type: 'text', text: 'done' }]);
  assert.equal((await status(t, 'claude', [done, { type: 'user', timestamp: now, message: { content: '<command-name>/clear</command-name>' } }])).state, 'free');
  assert.equal((await status(t, 'claude', [assistant('stop_sequence', [])])).state, 'free');
});

test('an open turn silent for too long is unknown, not busy', async (t) => {
  assert.equal((await status(t, 'claude', [assistant('tool_use', [], old)])).state, 'unknown');
});

test('no transcript is unknown', async (t) => {
  assert.equal((await status(t, 'claude')).state, 'unknown');
});

test('codex turn state follows task events and the plan', async (t) => {
  const plan = { type: 'response_item', timestamp: now, payload: { type: 'function_call', name: 'update_plan',
    arguments: JSON.stringify({ plan: [{ step: 'build', status: 'in_progress' }] }) } };
  const started = { type: 'event_msg', timestamp: now, payload: { type: 'task_started' } };
  const busy = await status(t, 'codex', [started, plan]);
  assert.equal(busy.state, 'busy');
  assert.deepEqual(busy.checklist, [{ text: 'build', status: 'in_progress' }]);
  const free = await status(t, 'codex', [started, plan, { type: 'event_msg', timestamp: now, payload: { type: 'task_complete' } }]);
  assert.equal(free.state, 'free');
});
