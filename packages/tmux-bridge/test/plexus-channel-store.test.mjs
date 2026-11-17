import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
const exec = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/mesh-graph.mjs', import.meta.url));

test('failed native state request stays reserved across replay and is never resent', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'channel-prepare-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'graph'), files = join(root, 'files'), sessions = join(root, 'sessions');
  await mkdir(files, { mode: 0o700 }); await mkdir(sessions, { mode: 0o700 });
  const env = { ...process.env, XDG_STATE_HOME: join(root, 'xdg'), XDG_CONFIG_HOME: join(root, 'config'), CODEX_SESSION_ROOT: sessions, MESH_COMMS_STATE: join(root, 'comms'), MESH_GRAPH_STATE: state, AGENT_FALLBACK_STATE: join(root, 'fallback') };
  delete env.MESH_COMMS_REPLAY_FD;
  const call = async (...args) => JSON.parse((await exec(process.execPath, [bin, '--state', state, ...args], { env, timeout: 30000 })).stdout);
  const uuid = '22222222-2222-4222-8222-222222222222';
  await call('add', '--agent', 'codex', '--tmux-target', 'fixture', '--cwd', '/synthetic', '--runtime-uuid', uuid, '--json');
  await call('migrate', '--apply', '--json');
  await call('channel', 'create', '--name', 'example', '--session', `codex:${uuid}`);
  await call('channel', 'begin-handover', '--name', 'example');
  await call('channel', 'enqueue', '--name', 'example', '--id', 'one', '--input', 'fixture');
  const args = ['channel', 'prepare-state', '--name', 'example', '--state-root', files, '--filename', 'state.yaml'];
  await assert.rejects(call(...args));
  await rm(join(state, 'checkpoint.json'), { force: true });
  const first = (await call('channel', 'get', '--name', 'example')).channel;
  assert.equal(first.statePreparation.status, 'requested');
  assert.equal(first.queue[0].state, 'pending');
  await assert.rejects(call(...args), /unresolved/);
  const second = (await call('channel', 'get', '--name', 'example')).channel;
  assert.deepEqual(second.statePreparation, first.statePreparation);
  assert.equal(second.queue[0].state, 'pending');
});

test('channel operations reject a graph with non-private persisted files', async (t) => {
  const state = await mkdtemp(join(tmpdir(), 'channel-permissions-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const call = async (...args) => JSON.parse((await exec(process.execPath, [bin, '--state', state, ...args])).stdout);
  const uuid = '22222222-2222-4222-8222-222222222222';
  await call('add', '--agent', 'codex', '--tmux-target', 'fixture', '--cwd', '/synthetic', '--runtime-uuid', uuid, '--json');
  await call('migrate', '--apply', '--json');
  await call('channel', 'create', '--name', 'example', '--session', `codex:${uuid}`);
  await chmod(join(state, 'events.jsonl'), 0o644);
  await assert.rejects(call('channel', 'enqueue', '--name', 'example', '--id', 'one', '--input', 'private'), /must be private/);
  await assert.rejects(call('channel', 'get', '--name', 'example'), /must be private/);
  await chmod(join(state, 'events.jsonl'), 0o600);
  assert.equal((await call('channel', 'get', '--name', 'example')).channel.queue.length, 0);
});

test('channel and queued messages survive concurrent writers, replay and compaction', async (t) => {
  const state = await mkdtemp(join(tmpdir(), 'channel-store-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const call = async (...args) => JSON.parse((await exec(process.execPath, [bin, '--state', state, ...args])).stdout);
  const uuid = '22222222-2222-4222-8222-222222222222';
  await call('add', '--agent', 'codex', '--tmux-target', 'fixture', '--cwd', '/synthetic', '--runtime-uuid', uuid, '--json');
  await call('migrate', '--apply', '--json');
  await call('channel', 'create', '--name', '#example', '--session', `codex:${uuid}`);
  const started = (await call('channel', 'begin-handover', '--name', '#example')).channel;
  assert.match(started.handoverId, /^handover-/);
  await Promise.all(['one', 'two'].map(id => call('channel', 'enqueue', '--name', '#example', '--id', id, '--input', id)));
  assert.equal((await call('channel', 'enqueue', '--name', '#example', '--id', 'one', '--input', 'one')).duplicate, true);
  await assert.rejects(call('channel', 'enqueue', '--name', '#example', '--id', 'one', '--input', 'changed'), /conflict/);
  await rm(join(state, 'checkpoint.json'));
  let channel = (await call('channel', 'get', '--name', '#example')).channel;
  assert.equal(channel.phase, 'handover');
  assert.equal(channel.handoverId, started.handoverId);
  assert.deepEqual(channel.queue.map(row => row.id).sort(), ['one', 'two']);
  await call('compact', '--all-history', '--apply', '--json');
  await rm(join(state, 'checkpoint.json'), { force: true });
  channel = (await call('channel', 'get', '--name', '#example')).channel;
  assert.deepEqual(channel.queue.map(row => row.id).sort(), ['one', 'two']);
});

test('cutover fails closed until old-session state authorship is verified', async (t) => {
  const state = await mkdtemp(join(tmpdir(), 'channel-cutover-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const writer = join(state, 'writer-fixture.mjs');
  await writeFile(writer, `console.log(JSON.stringify({agent:'codex',sessionId:'33333333-3333-4333-8333-333333333333',writers:[]}))`);
  const call = async (...args) => JSON.parse((await exec(process.execPath, [bin, '--state', state, ...args], {env: {...process.env, MESH_PLEXUS_WRITER_STATUS: writer}})).stdout);
  const one = '22222222-2222-4222-8222-222222222222', two = '33333333-3333-4333-8333-333333333333';
  for (const uuid of [one, two]) await call('add', '--agent', 'codex', '--tmux-target', `test-${uuid}`, '--cwd', '/synthetic', '--runtime-uuid', uuid, '--json');
  await call('migrate', '--apply', '--json');
  await call('channel', 'create', '--name', 'example', '--session', `codex:${one}`);
  await call('channel', 'begin-handover', '--name', 'example');
  const target = `codex:${two}`;
  await assert.rejects(call('channel', 'finish-handover', '--name', 'example', '--to', target), /fresh verified link/);
  const graph = await call('show', '--json');
  const node = graph.nodes.find(row => row.runtimeUuid === two);
  const checkedAt = new Date().toISOString();
  node.sessionLink = { status: 'ok', resolvedSession: target, link: target, source: 'codex-threads', checkedAt, lastKnown: false };
  const fixture = { schema: 'agent-mesh.session-graph-event.v1', id: 'fixture-proof', type: 'node.upserted', at: checkedAt, node, seq: graph.lastSeq + 1, host: 'local' };
  await appendFile(join(state, 'events.jsonl'), `${JSON.stringify(fixture)}\n`);
  await assert.rejects(call('channel', 'finish-handover', '--name', 'example', '--to', target), /one verified writer/);
  await writeFile(writer, `console.log(JSON.stringify({agent:'codex',sessionId:'33333333-3333-4333-8333-333333333333',writers:[{pid:123,kind:'codex'}]}))`);
  await assert.rejects(call('channel', 'finish-handover', '--name', 'example', '--to', target), /old-session state verification unavailable/);
  await rm(join(state, 'checkpoint.json'));
  assert.equal((await call('channel', 'get', '--name', 'example')).channel.session, `codex:${one}`);
  assert.equal((await call('channel', 'get', '--name', 'example')).channel.phase, 'handover');
});

test('delivery reservation and matching receipt survive graph replay', async (t) => {
  const state = await mkdtemp(join(tmpdir(), 'channel-delivery-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const call = async (...args) => JSON.parse((await exec(process.execPath, [bin, '--state', state, ...args])).stdout);
  const uuid = '22222222-2222-4222-8222-222222222222', session = `codex:${uuid}`;
  await call('add', '--agent', 'codex', '--tmux-target', 'fixture', '--cwd', '/synthetic', '--runtime-uuid', uuid, '--json');
  await call('migrate', '--apply', '--json');
  await call('channel', 'create', '--name', 'example', '--session', session);
  await call('channel', 'enqueue', '--name', 'example', '--id', 'one', '--input', 'payload');
  await assert.rejects(call('channel', 'begin-delivery', '--name', 'example', '--id', 'one', '--session', 'codex:other'), /recipient changed/);
  await assert.rejects(call('channel', 'begin-delivery', '--name', 'example', '--id', 'one', '--session', session, '--generation', '2'), /generation changed/);
  await assert.rejects(call('channel', 'begin-delivery', '--name', 'example', '--id', 'one', '--generation', '1.0'), /invalid channel generation/);
  await assert.rejects(call('channel', 'begin-delivery', '--name', 'example', '--id', 'one', '--generation', '9007199254740992'), /generation changed/);
  assert.equal((await call('channel', 'get', '--name', 'example')).channel.queue[0].state, 'pending');
  await call('channel', 'begin-delivery', '--name', 'example', '--id', 'one', '--session', session, '--generation', '1');
  await rm(join(state, 'checkpoint.json'));
  assert.equal((await call('channel', 'get', '--name', 'example')).channel.queue[0].state, 'inflight');
  await assert.rejects(call('channel', 'acknowledge', '--name', 'example', '--id', 'one', '--input', JSON.stringify({ status: 'accepted', messageId: 'one', session: 'codex:wrong', generation: 1 })), /receipt/);
  await call('channel', 'acknowledge', '--name', 'example', '--id', 'one', '--input', JSON.stringify({ status: 'accepted', messageId: 'one', session, generation: 1 }));
  assert.equal((await call('channel', 'get', '--name', 'example')).channel.queue[0].state, 'accepted');
});

test('predecessor notice after a synthetic draining transition persists across replay', async t => {
  const state = await mkdtemp(join(tmpdir(), 'notice-reserve-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const writer = join(state, 'writer.mjs'), sessions = join(state, 'sessions'), oldId = '22222222-2222-4222-8222-222222222222', nextId = '33333333-3333-4333-8333-333333333333';
  await mkdir(sessions, { mode: 0o700 });
  await writeFile(writer, `console.log(JSON.stringify({agent:'codex',sessionId:'${nextId}',writers:[{pid:123,kind:'codex'}]}))`);
  const call = async (...args) => JSON.parse((await exec(process.execPath, [bin, '--state', state, ...args], { env: { ...process.env, MESH_PLEXUS_WRITER_STATUS: writer, CODEX_SESSION_ROOT: sessions } })).stdout);
  for (const id of [oldId, nextId]) await call('add', '--agent', 'codex', '--tmux-target', `test-${id}`, '--cwd', '/synthetic', '--runtime-uuid', id, '--json');
  await call('migrate', '--apply', '--json');
  await call('channel', 'create', '--name', 'example', '--session', `codex:${oldId}`);
  await call('channel', 'begin-handover', '--name', 'example');
  const args = ['channel', 'reserve-notice', '--name', 'example', '--to', `codex:${nextId}`, '--input', JSON.stringify({ prefix: 'Sleeping.', label: 'Continue' })];
  await assert.rejects(call(...args), /fresh verified link/);
  let graph = await call('show', '--json');
  const node = graph.nodes.find(row => row.runtimeUuid === nextId), checkedAt = new Date().toISOString();
  node.sessionLink = { status: 'ok', resolvedSession: `codex:${nextId}`, link: `codex:${nextId}`, source: 'codex-threads', checkedAt, lastKnown: false };
  await appendFile(join(state, 'events.jsonl'), `${JSON.stringify({ schema: 'agent-mesh.session-graph-event.v1', id: 'fixture-link', type: 'node.upserted', at: checkedAt, node, seq: graph.lastSeq + 1, host: 'local' })}\n`);
  await assert.rejects(call(...args), /reservation unavailable/);
  graph = await call('show', '--json');
  const channel = graph.channels.find(row => row.id === 'example');
  channel.statePreparation = { status: 'verified', session: `codex:${oldId}`, generation: channel.generation, id: 'state-1', filename: 'state.yaml', sha256: 'b'.repeat(64), bytes: 2 };
  await appendFile(join(state, 'events.jsonl'), `${JSON.stringify({ schema: 'agent-mesh.session-graph-event.v1', id: 'fixture-state', type: 'channel.updated', at: new Date().toISOString(), channel, seq: graph.lastSeq + 1, host: 'local' })}\n`);
  // The operational cutover is disabled. Inject only a synthetic graph event to
  // exercise the following durable state; this is not a native cutover proof.
  await assert.rejects(call(...args), /reservation unavailable/);
  graph = await call('show', '--json');
  const draining = graph.channels.find(row => row.id === 'example');
  draining.handover = { predecessor: `codex:${oldId}`, previousGeneration: 1, successor: `codex:${nextId}`, backlog: [] };
  draining.session = `codex:${nextId}`; draining.generation = 2; draining.phase = 'draining';
  await appendFile(join(state, 'events.jsonl'), `${JSON.stringify({ schema: 'agent-mesh.session-graph-event.v1', id: 'fixture-draining', type: 'channel.updated', at: new Date().toISOString(), channel: draining, seq: graph.lastSeq + 1, host: 'local' })}\n`);
  const first = (await call(...args)).channel.finalNotice;
  assert.equal(first.status, 'requested');
  assert.equal(first.successor, `codex:${nextId}`);
  await rm(join(state, 'checkpoint.json'), { force: true });
  assert.deepEqual((await call('channel', 'get', '--name', 'example')).channel.finalNotice, first);
  await assert.rejects(call(...args), /reservation unavailable/);
  const notice = `Sleeping. [Continue](codex://threads/${nextId})`;
  const records = [
    { type: 'session_meta', payload: { id: oldId } },
    { type: 'event_msg', payload: { type: 'user_message', message: `[HANDOVER:${first.id}] synthetic request` } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: notice }] } },
    { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: notice } }
  ];
  await writeFile(join(sessions, `rollout-${oldId}.jsonl`), records.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
  const observe = ['channel', 'observe-notice', '--name', 'example', '--input', JSON.stringify({ prefix: 'Sleeping.', label: 'Continue' })];
  await assert.rejects(call('channel', 'observe-notice', '--name', 'example', '--input', JSON.stringify({ prefix: 'wrong', label: 'Continue' })), /not proven/);
  const observed = (await call(...observe)).channel.finalNotice;
  assert.equal(observed.status, 'observed-snapshot');
  assert.match(observed.transcriptSha256, /^[a-f0-9]{64}$/);
  await rm(join(state, 'checkpoint.json'), { force: true });
  assert.equal((await call('channel', 'get', '--name', 'example')).channel.finalNotice.status, 'observed-snapshot');
  await assert.rejects(call('channel', 'finish-handover', '--name', 'example', '--to', `codex:${nextId}`), /old-session state verification unavailable/);
});

test('local Claude delivery is observed only from a matching user transcript and persists', async t => {
  const root = await mkdtemp(join(tmpdir(), 'claude-channel-observe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'graph'), sessions = join(root, 'sessions'), project = join(sessions, 'project');
  await mkdir(sessions, { mode: 0o700 }); await mkdir(project, { mode: 0o700 });
  const oldId = '22222222-2222-4222-8222-222222222222', newId = '33333333-3333-4333-8333-333333333333', target = `claude:${newId}`;
  const env = { ...process.env, CLAUDE_SESSION_ROOT: sessions };
  const call = async (...args) => JSON.parse((await exec(process.execPath, [bin, '--state', state, ...args], { env })).stdout);
  await call('add', '--agent', 'codex', '--tmux-target', 'fixture', '--cwd', '/synthetic', '--runtime-uuid', oldId, '--json');
  await call('migrate', '--apply', '--json');
  await call('channel', 'create', '--name', 'example', '--session', `codex:${oldId}`);
  const graph = await call('show', '--json'), channel = graph.channels.find(row => row.id === 'example');
  channel.session = target; channel.generation = 2; channel.phase = 'draining';
  channel.handover = { predecessor: `codex:${oldId}`, previousGeneration: 1, successor: target, backlog: ['one'] };
  channel.queue = [{ id: 'one', payload: 'fixture', state: 'accepted', session: target, generation: 2 }];
  await appendFile(join(state, 'events.jsonl'), `${JSON.stringify({ schema: 'agent-mesh.session-graph-event.v1', id: 'fixture-draining', type: 'channel.updated', at: new Date().toISOString(), channel, seq: graph.lastSeq + 1, host: 'local' })}\n`);
  const inbox = { schema: 'agent-mesh.monitor-inbox.v1', deliveryId: 'one', meshId: 'one', prompt: 'fixture' };
  const text = `AGENT_MESH_INBOX ${JSON.stringify(inbox)}`, path = join(project, `${newId}.jsonl`);
  await writeFile(path, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: newId, content: text }) + '\n', { mode: 0o600 });
  await assert.rejects(call('channel', 'observe-claude-delivery', '--name', 'example', '--id', 'one'), /not uniquely observed/);
  await appendFile(path, JSON.stringify({ type: 'user', isMeta: true, sessionId: newId, message: { role: 'user', content: text } }) + '\n');
  const result = await call('channel', 'observe-claude-delivery', '--name', 'example', '--id', 'one');
  assert.equal(result.status, 'observed'); assert.match(result.evidence, /^claude-transcript:[a-f0-9]{64}$/);
  await appendFile(path, JSON.stringify({ type: 'assistant', sessionId: newId }) + '\n');
  assert.equal((await call('channel', 'verify-claude-delivery', '--name', 'example', '--id', 'one')).status, 'verified');
  const original = await readFile(path, 'utf8');
  await writeFile(path, original.replace('fixture', 'changed'));
  await assert.rejects(call('channel', 'verify-claude-delivery', '--name', 'example', '--id', 'one'));
  await writeFile(path, original);
  await rm(join(state, 'checkpoint.json'), { force: true });
  assert.equal((await call('channel', 'get', '--name', 'example')).channel.queue[0].state, 'observed');
});

test('graph revalidates the bound restart file without advancing handover', async t => {
  const { createHash } = await import('node:crypto');
  const root = await mkdtemp(join(tmpdir(), 'handover-revalidate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'graph'), files = join(root, 'files'); await mkdir(files, { mode: 0o700 });
  const id = '22222222-2222-4222-8222-222222222222', session = `codex:${id}`, filename = 'state.yaml';
  const content = `schema: agent-mesh.restart.v1\nsession: ${session}\nchannel: '#example'\nharness: codex\nworking_directory: /workspace\nskills: []\ntriggers: []\ngoal: null\nrole_profile:\n  schema: agent-mesh.role-profile.v1\n  role: operator\n  permissions: []\n  mcp: []\n  plugins: []\n`;
  await writeFile(join(files, filename), content, { mode: 0o600 });
  const call = async (...args) => JSON.parse((await exec(process.execPath, [bin, '--state', state, ...args])).stdout);
  await call('add', '--agent', 'codex', '--tmux-target', 'fixture', '--cwd', '/synthetic', '--runtime-uuid', id, '--json');
  await call('migrate', '--apply', '--json'); await call('channel', 'create', '--name', '#example', '--session', session);
  await call('channel', 'begin-handover', '--name', '#example');
  let graph = await call('show', '--json');
  const channel = graph.channels.find(row => row.id === '#example');
  channel.statePreparation = { status: 'verified', session, generation: 1, id: 'fixture-state', filename, sha256: createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content) };
  await appendFile(join(state, 'events.jsonl'), `${JSON.stringify({ schema: 'agent-mesh.session-graph-event.v1', id: 'fixture-state', type: 'channel.updated', at: new Date().toISOString(), channel, seq: graph.lastSeq + 1, host: 'local' })}\n`);
  graph = await call('show', '--json'); const seq = graph.lastSeq;
  const args = ['channel', 'revalidate-state', '--name', '#example', '--state-root', files];
  const proof = await call(...args);
  assert.equal(proof.status, 'verified-snapshot'); assert.equal(proof.generation, 1);
  assert.equal((await call('show', '--json')).lastSeq, seq);
  await writeFile(join(files, filename), content.replace('operator', 'operatOr'), { mode: 0o600 });
  await assert.rejects(call(...args), /digest mismatch/);
  assert.equal((await call('channel', 'get', '--name', '#example')).channel.phase, 'handover');
});

test('successor launch reservation survives replay and cannot be duplicated', async t => {
  const state = await mkdtemp(join(tmpdir(), 'launch-reservation-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const call = async (...args) => JSON.parse((await exec(process.execPath, [bin, '--state', state, ...args])).stdout);
  const uuid = '22222222-2222-4222-8222-222222222222', session = `codex:${uuid}`;
  await call('add', '--agent', 'codex', '--tmux-target', 'fixture', '--cwd', '/synthetic', '--runtime-uuid', uuid, '--json');
  await call('migrate', '--apply', '--json');
  await call('channel', 'create', '--name', 'example', '--session', session);
  await call('channel', 'begin-handover', '--name', 'example');
  const graph = await call('show', '--json'), channel = graph.channels.find(row => row.id === 'example');
  channel.statePreparation = { status: 'verified', session, generation: 1, id: 'prep', filename: 'state.yaml', sha256: 'a'.repeat(64), bytes: 1 };
  await appendFile(join(state, 'events.jsonl'), `${JSON.stringify({ schema: 'agent-mesh.session-graph-event.v1', id: 'fixture-prepared', type: 'channel.updated', at: new Date().toISOString(), channel, seq: graph.lastSeq + 1, host: 'local' })}\n`);
  const args = ['channel', 'reserve-successor', '--name', 'example', '--id', channel.handoverId, '--session', session, '--generation', '1', '--input', JSON.stringify({ id: 'launch-1', profileSha256: 'b'.repeat(64) })];
  const reserved = await call(...args);
  assert.equal(reserved.channel.successorLaunch.status, 'requested');
  await assert.rejects(call(...args), /unresolved/);
  await rm(join(state, 'checkpoint.json'), { force: true });
  const restored = (await call('channel', 'get', '--name', 'example')).channel;
  assert.equal(restored.successorLaunch.id, 'launch-1');
  assert.equal(restored.successorLaunch.stateSha256, 'a'.repeat(64));
  assert.equal(restored.successorLaunch.handoverId, channel.handoverId);
});


test('crashed reservation owner leaves duplicate reservation blocked', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'launch-crash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'graph'), worker = join(root, 'worker.mjs');
  const call = async (...args) => JSON.parse((await exec(process.execPath, [bin, '--state', state, ...args])).stdout);
  const uuid = '22222222-2222-4222-8222-222222222222', session = `codex:${uuid}`;
  await call('add', '--agent', 'codex', '--tmux-target', 'fixture', '--cwd', '/synthetic', '--runtime-uuid', uuid, '--json');
  await call('migrate', '--apply', '--json');
  await call('channel', 'create', '--name', 'example', '--session', session);
  await call('channel', 'begin-handover', '--name', 'example');
  await call('channel', 'enqueue', '--name', 'example', '--id', 'msg', '--input', 'fixture');
  const graph = await call('show', '--json'), channel = graph.channels.find(row => row.id === 'example');
  channel.statePreparation = { status: 'verified', session, generation: 1, id: 'prep', filename: 'state.yaml', sha256: 'a'.repeat(64), bytes: 1 };
  await appendFile(join(state, 'events.jsonl'), `${JSON.stringify({ schema: 'agent-mesh.session-graph-event.v1', id: 'fixture-prepared', type: 'channel.updated', at: new Date().toISOString(), channel, seq: graph.lastSeq + 1, host: 'local' })}\n`);
  const args = ['channel', 'reserve-successor', '--name', 'example', '--id', channel.handoverId, '--session', session, '--generation', '1', '--input', JSON.stringify({ id: 'launch-1', profileSha256: 'b'.repeat(64) })];
  await writeFile(worker, `import { execFileSync } from 'node:child_process'; execFileSync(process.execPath, ${JSON.stringify([bin, '--state', state, ...args])}); process.send('reserved'); setInterval(() => {}, 1000);`);
  const child = fork(worker, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await new Promise((resolve, reject) => { child.once('message', value => value === 'reserved' ? resolve() : reject(Error('unexpected child message'))); child.once('error', reject); child.once('exit', () => reject(Error('child exited before reservation'))); });
  const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
  await rm(join(state, 'checkpoint.json'), { force: true });
  const after = (await call('channel', 'get', '--name', 'example')).channel;
  assert.equal(after.session, session); assert.equal(after.phase, 'handover');
  assert.equal(after.successorLaunch.id, 'launch-1'); assert.equal(after.queue[0].state, 'pending');
  await assert.rejects(call(...args), /unresolved/);
});
