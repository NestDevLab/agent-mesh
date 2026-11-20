import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../bin/agent-send.sh', import.meta.url));
test('stdin delivery keeps the payload out of child arguments and does not touch an absent target', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mesh-stdin-')); t.after(() => rm(root, { recursive: true, force: true }));
  const log = join(root, 'args');
  await writeFile(join(root, 'python3'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$FIXTURE_LOG"\nexec /usr/bin/python3 "$@"\n', { mode: 0o755 });
  await writeFile(join(root, 'tmux'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
  const marker = 'fixture-private-payload';
  const env = { ...process.env, HOME: root, PATH: `${root}:${process.env.PATH}`, FIXTURE_LOG: log, MESH_COMMS_STATE: join(root, 'comms'), AGENT_FALLBACK_STATE: join(root, 'fallback'), MESH_GRAPH_DISABLE: '1' };
  const result = spawnSync('/bin/bash', [script, '--agent', 'codex', '--submit-only', '--correlation-id', 'fixture', '--message-stdin', 'absent'], { input: marker, encoding: 'utf8', env });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /not found/);
  assert.ok(!(await readFile(log, 'utf8')).includes(marker));
  assert.ok(!result.stdout.includes(marker)); assert.ok(!result.stderr.includes(marker));
});

test('stdin mode rejects trailing newline, NUL and missing correlation', () => {
  const base = [script, '--agent', 'codex', '--submit-only', '--correlation-id', 'fixture', '--message-stdin', 'absent'];
  for (const input of ['fixture\n', 'fixture\0part']) assert.notEqual(spawnSync('/bin/bash', base, { input, encoding: 'utf8', env: { ...process.env, PYTHONOPTIMIZE: '1' } }).status, 0);
  assert.notEqual(spawnSync('/bin/bash', [script, '--submit-only', '--message-stdin', 'absent'], { input: 'fixture', encoding: 'utf8' }).status, 0);
});
