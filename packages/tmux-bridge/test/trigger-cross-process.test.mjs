import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { triggerJournal } from '../bin/trigger-journal.mjs';
import { recoverUncertainTriggers } from '../bin/trigger-transaction.mjs';

// The SQLite adapter is a disposable, durable CAS fixture, not an adapter for live timers.
const python = `import json, sqlite3, sys\ndb=sqlite3.connect(sys.argv[1], timeout=5, isolation_level=None)\nmode=sys.argv[2]\nif mode=='init':\n db.execute('CREATE TABLE state(target TEXT, version INTEGER, op TEXT)')\n db.execute('INSERT INTO state VALUES(?,?,?)',('old',1,None))\nelif mode=='read':\n r=db.execute('SELECT target,version,op FROM state').fetchone()\n print(json.dumps(dict(target=r[0],version='v'+str(r[1]),lastOperationId=r[2])))\nelse:\n a=json.loads(sys.argv[3]); db.execute('BEGIN IMMEDIATE')\n r=db.execute('SELECT target,version FROM state').fetchone()\n if r[0]!=a['expectedTarget'] or 'v'+str(r[1])!=a['expectedVersion']:\n  db.execute('ROLLBACK'); print(json.dumps(dict(status='not-applied')))\n else:\n  v=r[1]+1; db.execute('UPDATE state SET target=?,version=?,op=?',(a['target'],v,a['operationId'])); db.execute('COMMIT'); print(json.dumps(dict(status='applied',version='v'+str(v))))\n`;
const worker = `import { execFileSync } from 'node:child_process';
import { triggerJournal } from ${JSON.stringify(new URL('../bin/trigger-journal.mjs', import.meta.url).href)};
import { reconcileTriggers } from ${JSON.stringify(new URL('../bin/trigger-transaction.mjs', import.meta.url).href)};
const [root, script, db, mode] = process.argv.slice(2);
const call = (op, arg) => JSON.parse(execFileSync('python3', [script, db, op, ...(arg ? [JSON.stringify(arg)] : [])], {encoding:'utf8'}));
const adapter = { read: async () => call('read'), move: async args => {
  if (mode === 'delayed' && args.operationId === 'tx:0') { process.send('waiting'); await new Promise(resolve => process.once('message', resolve)); }
  const result = call('cas', args);
  if (mode === 'crash' && args.operationId === 'tx:0') { process.send('applied'); await new Promise(() => {}); }
  return result;
} };
try { await reconcileTriggers({triggers:[{kind:'fixture',id:'one'}],from:'old',to:'new',transactionId:'tx',adapter,journal:triggerJournal(root),dryRun:false}); process.send('completed'); }
catch { process.send('fenced'); }
`;

for (const mode of ['delayed', 'crash']) test(`cross-process ${mode} trigger recovery`, { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'trigger-cross-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, 'cas.py'), workerFile = join(root, 'worker.mjs'), db = join(root, 'fixture.db');
  await writeFile(script, python); await writeFile(workerFile, worker);
  execFileSync('python3', [script, db, 'init']);
  const call = (op, arg) => JSON.parse(execFileSync('python3', [script, db, op, ...(arg ? [JSON.stringify(arg)] : [])], { encoding: 'utf8' }));
  const adapter = { read: async () => call('read'), move: async args => call('cas', args) };
  const child = fork(workerFile, [root, script, db, mode], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const message = () => new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
  assert.equal(await message(), mode === 'delayed' ? 'waiting' : 'applied');
  if (mode === 'crash') {
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
  }
  const journal = triggerJournal(root);
  assert.equal((await journal.get('tx')).status, 'applying');
  const result = await recoverUncertainTriggers({ transactionId: 'tx', adapter, journal });
  assert.equal(result.status, 'rolled-back');
  if (mode === 'delayed') { const ended = message(); child.send('continue'); assert.equal(await ended, 'fenced'); }
  const final = call('read');
  assert.equal(final.target, 'old'); assert.equal(final.lastOperationId, 'tx:rollback:0');
  assert.equal((await journal.get('tx')).status, 'rolled-back');
});
