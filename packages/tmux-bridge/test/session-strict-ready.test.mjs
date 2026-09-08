import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const bridge = dirname(dirname(fileURLToPath(import.meta.url)));

async function probe(mode) {
  const root = await mkdtemp(join(tmpdir(), 'mesh-strict-ready-'));
  try {
    await mkdir(join(root, 'bin'));
    await mkdir(join(root, 'agents'));
    await mkdir(join(root, 'fake-bin'));
    for (const name of ['agent-session.sh', '_mesh-tmux.sh', '_mesh-graph.sh']) {
      try { await copyFile(join(bridge, 'bin', name), join(root, 'bin', name)); }
      catch (error) { if (name !== '_mesh-graph.sh' || error.code !== 'ENOENT') throw error; }
    }
    await writeFile(join(root, 'agents', 'probe.conf'), `
AGENT_BIN="bash"
AGENT_NAME="probe"
TMUX_SESSION_PREFIX="mesh"
AGENT_RESUME_CMD="bash"
AGENT_PROMPT_CHAR="READY>"
AGENT_IDLE_PATTERN="READY>"
AGENT_ALIVE_PROCESS_PATTERN="^codex$"
AGENT_HAS_CWD_PICKER="false"
AGENT_REQUIRE_FREE_SESSION_WRITER="false"
`);
    const state = join(root, 'state');
    if (mode !== 'slow-new') await writeFile(state, 'present');
    const fakeTmux = join(root, 'fake-bin', 'tmux');
    await writeFile(fakeTmux, `#!/bin/bash
shift 2
case "$1" in
  has-session) test -f "$TEST_STATE" ;;
  new-session) touch "$TEST_STATE" ;;
  kill-session) printf killed > "$TEST_STATE.killed"; rm -f "$TEST_STATE" ;;
  capture-pane) if [[ "$TEST_MODE" == "slow-new" ]]; then echo Loading; else echo 'READY>'; fi ;;
  display-message) if [[ "$TEST_MODE" == "dead-existing" ]]; then echo bash; else echo codex; fi ;;
  *) exit 0 ;;
esac
`);
    await chmod(fakeTmux, 0o755);
    await writeFile(join(root, 'fake-bin', 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    let result;
    try {
      result = { code: 0, ...await exec('bash', [join(root, 'bin', 'agent-session.sh'), '--agent', 'probe', 'resume', '11111111-1111-4111-8111-111111111111', 'test-target'], {
        env: { ...process.env, AGENT_MESH_AGENTS_DIR: join(root, 'agents'), PATH: `${join(root, 'fake-bin')}:${process.env.PATH}`, TEST_STATE: state, TEST_MODE: mode, MESH_STRICT_READY: '1', MESH_GRAPH_DISABLE: '1', MESH_TMUX_SOCKET: 'strict-fixture' },
        timeout: 5000
      }) };
    } catch (error) { result = { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
    const killed = await readFile(`${state}.killed`, 'utf8').then(() => true, () => false);
    return { ...result, killed };
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('strict resume rejects a dead existing pane without removing it', async () => {
  const result = await probe('dead-existing');
  assert.equal(result.code, 124, result.stderr);
  assert.equal(result.killed, false);
  assert.equal(result.stdout, '');
});

test('strict resume retires only its new target when startup never becomes ready', async () => {
  const result = await probe('slow-new');
  assert.equal(result.code, 124, result.stderr);
  assert.equal(result.killed, true);
  assert.equal(result.stdout, '');
});

test('strict resume retains and returns a ready existing target', async () => {
  const result = await probe('ready-existing');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.killed, false);
  assert.equal(result.stdout.trim(), 'test-target');
});
