import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { roleOperation, claimState, catalogList } from '../bin/session-catalog.mjs';
const exec = promisify(execFile);
const bin = new URL('../bin/mesh-graph.mjs', import.meta.url).pathname;
const a = 'claude:11111111-1111-4111-8111-111111111111', b = 'codex:22222222-2222-4222-8222-222222222222';
async function run(state, ...args) {
  try { const r = await exec(process.execPath, [bin, '--state', state, '--json', ...args]); return { code: 0, data: JSON.parse(r.stdout) }; }
  catch (e) { return { code: e.code, error: e.stderr }; }
}
async function ok(state, ...args) { const r = await run(state, ...args); assert.equal(r.code, 0, r.error); return r.data; }
async function fixture(fn) {
 const state = await mkdtemp(join(tmpdir(), 'catalog-'));
 try {
  for (const [i,s] of [a,b].entries()) await ok(state, 'add', '--agent', s.split(':')[0], '--runtime-uuid', s.split(':')[1], '--tmux-target', `test-${i}`, '--cwd', '/work/example', '--title', 'Original');
  await ok(state, 'migrate', '--apply');
  await fn(state);
 } finally { await rm(state,{recursive:true,force:true}); }
}
const claim = (s, ...extra) => ['role','claim','--session',s,'--role','director','--project','example',...extra];
const action = (op,s,id) => ['role',op,'--session',s,'--role','director','--project','example','--claim-id',id];

test('catalog labels survive discovery projection and singleton labels require a grant', () => fixture(async state => {
 await ok(state,'catalog','update','--session',a,'--role','worker','--project','example','--title','Readable work');
 const rows = (await ok(state,'catalog','list','--project','example')).sessions;
 assert.equal(rows.length,1); assert.equal(rows[0].title,'Readable work'); assert.equal(rows[0].runtime,'claude');
 assert.notEqual((await run(state,'catalog','update','--session',a,'--role','director')).code,0);
 assert.notEqual((await run(state,'catalog','update','--session',a,'--status','superseded')).code,0);
}));

test('parallel cross-runtime singleton claims have one winner and disclose the incumbent', () => fixture(async state => {
 const attempts = await Promise.all([run(state,...claim(a)), run(state,...claim(b))]);
 assert.equal(attempts.filter(r=>r.code===0).length,1);
 const winner = attempts.find(r=>r.code===0).data.claim;
 assert.match(attempts.find(r=>r.code!==0).error, new RegExp(winner.session));
 const rows = (await ok(state,'role','list')).claims;
 assert.equal(rows.filter(c=>c.status==='active').length,1);
 assert.equal((await ok(state,...claim(winner.session))).claim.id,winner.id);
 assert.notEqual((await run(state,...action('release',winner.session,'wrong'))).code,0);
 await ok(state,...action('heartbeat',winner.session,winner.id));
 await ok(state,...action('release',winner.session,winner.id));
 assert.notEqual((await run(state,...action('heartbeat',winner.session,winner.id))).code,0);
}));

test('takeover atomically supersedes, inherits links and edges, fences the old token and survives replay/compaction', () => fixture(async state => {
 const first = (await ok(state,...claim(a))).claim;
 await ok(state,'link','open','--agent','claude','--runtime-uuid',a.split(':')[1],'--ref','work:example/1');
 const before = await ok(state,'show'); const na=before.nodes.find(n=>n.agent==='claude'), nb=before.nodes.find(n=>n.agent==='codex');
 await ok(state,'link','--from',na.id,'--to',nb.id,'--type','delegates-to');
 assert.notEqual((await run(state,...claim(b,'--take-over',first.id))).code,0);
 const next = (await ok(state,...claim(b,'--take-over',first.id,'--reason','Explicit successor'))).claim;
 assert.notEqual((await run(state,...action('heartbeat',a,first.id))).code,0);
 assert.notEqual((await run(state,...action('release',a,first.id))).code,0);
 await ok(state,...action('check',b,next.id));
 let graph = await ok(state,'show');
 assert.equal(graph.nodes.find(n=>n.id===na.id).catalogStatus,'superseded');
 assert.equal(graph.links.filter(l=>l.until===null && l.session===b).length,1);
 assert.equal(graph.links.filter(l=>l.until===null && l.session===a).length,0);
 assert.equal(graph.edges.filter(e=>!e.endedAt).length,0, 'inherited self edge is omitted');
 assert.equal((await ok(state,'role','list')).claims.find(c=>c.id===first.id).status,'superseded');
 // Drop the derived checkpoint to prove the event log alone reconstructs state.
 await rm(join(state,'checkpoint.json'));
 assert.deepEqual((await ok(state,'show')).roleClaims, graph.roleClaims);
 await ok(state,'compact','--all-history','--apply');
 assert.deepEqual((await ok(state,'show')).roleClaims, graph.roleClaims);
 const events=(await readFile(join(state,'snapshot.json'),'utf8'));
 assert.match(events,/roleClaims/);
 assert.notEqual((await run(state,...claim(a))).code,0);
}));

test('stale claims require named takeover, expired heartbeat fails, daily and holding roles are global', () => {
 const nodes=[{id:'a',agent:'claude',runtimeUuid:a.split(':')[1],status:'active'},{id:'b',agent:'codex',runtimeUuid:b.split(':')[1],status:'active'}];
 const old={id:'old',key:'director:example',session:a,role:'director',project:'example',status:'active',ttl:1,expiresAt:new Date(0).toISOString()};
 const graph={nodes,links:[],edges:[],roleClaims:[old]};
 const opts={session:b,role:'director',project:'example'};
 const ev=(type,fields)=>({type,...fields});
 assert.equal(claimState(old),'stale');
 assert.throws(()=>roleOperation(graph,'claim',opts,ev),/stale/);
 assert.throws(()=>roleOperation(graph,'heartbeat',{...opts,session:a,'claim-id':'old'},ev),/expired/);
 const result=roleOperation(graph,'claim',{...opts,'take-over':'old',reason:'Expired holder'},ev);
 assert.equal(result.events.length,1); assert.equal(result.events[0].previous.staleAtTakeover,true);
 for (const role of ['daily','holding-director']) {
  const c=roleOperation({...graph,roleClaims:[]},'claim',{session:a,role,project:'example'},ev).result.claim;
  assert.throws(()=>roleOperation({...graph,roleClaims:[c]},'claim',{session:b,role,project:'other'},ev),/role held/);
 }
});

test('purged holders can be taken over; one session cannot silently hold multiple roles', () => fixture(async state => {
 const first=(await ok(state,...claim(a))).claim;
 assert.notEqual((await run(state,'role','claim','--session',a,'--role','daily','--project','example')).code,0);
 const old=(await ok(state,'show')).nodes.find(n=>n.agent==='claude');
 await ok(state,'purge','--id',old.id);
 await ok(state,...claim(b,'--take-over',first.id,'--reason','Holder purged'));
 await rm(join(state,'checkpoint.json'));
 assert.equal((await ok(state,'role','list')).claims.filter(c=>c.status==='active').length,1);
}));

test('compound takeover invalidates scoped sessions and relationships and replays identical event IDs', () => fixture(async state => {
 const first=(await ok(state,...claim(a))).claim;
 await ok(state,'link','open','--agent','claude','--runtime-uuid',a.split(':')[1],'--ref','work:example/1');
 const baseline=await ok(state,'query','changes','--input','{}');
 await ok(state,...claim(b,'--take-over',first.id,'--reason','Handoff'));
 const scope={refPrefixes:['work:example/'],targets:[{id:'example',harness:'claude',roots:['/work/example']},{id:'example-codex',harness:'codex',roots:['/work/example']}],handleKey:'test-key-abcdefgh-ijklmnop'};
 const q={sinceCursor:baseline.cursor,scope};
 const changes=await ok(state,'query','changes','--input',JSON.stringify(q));
 assert.ok(changes.events.length > 0);
 assert.ok(changes.events.every(e=>e.type !== 'session.created'));
 assert.ok(changes.events.some(e=>e.type==='session.updated' && e.session===a));
 assert.ok(changes.events.some(e=>e.type==='edge.ended'));
 assert.ok(changes.events.some(e=>e.type==='edge.added'));
 assert.deepEqual(changes, await ok(state,'query','changes','--input',JSON.stringify(q)));
 const hidden=await ok(state,'query','changes','--input',JSON.stringify({...q,scope:{...scope,targets:[]}}));
 assert.equal(hidden.events.length,0);
}));

test('role run checks the exact lease and holds the graph lock across the writer', () => fixture(async state => {
 const first=(await ok(state,...claim(a))).claim;
 const payload=JSON.stringify({argv:[process.execPath,'-e','console.log(JSON.stringify({pid:process.env.PROJECT_DIRECTOR_GUARD_PID,claim:process.env.PROJECT_DIRECTOR_GUARD_CLAIM}))']});
 const guarded=await ok(state,...action('run',a,first.id),'--input',payload);
 assert.equal(guarded.claim,first.id); assert.match(guarded.pid,/^\d+$/);
 await ok(state,...claim(b,'--take-over',first.id,'--reason','New writer'));
 assert.notEqual((await run(state,...action('run',a,first.id),'--input',payload)).code,0);
}));


test('guarded writer is killed at lease expiry even when SIGTERM is ignored', () => fixture(async state => {
 const first=(await ok(state,...claim(a,'--ttl','1'))).claim;
 const output=join(state,'late-write');
 const code=`process.on('SIGTERM',()=>{});setTimeout(()=>require('fs').writeFileSync(process.argv[1],'late'),1500);setTimeout(()=>{},10000)`;
 const started=Date.now();
 const result=await run(state,...action('run',a,first.id),'--input',JSON.stringify({argv:[process.execPath,'-e',code,output]}));
 assert.notEqual(result.code,0); assert.ok(Date.now()-started<1400);
 await new Promise(resolve=>setTimeout(resolve,700));
 await assert.rejects(readFile(output));
}));

test('concurrent takeover waits for the guarded writer to finish', () => fixture(async state => {
 const first=(await ok(state,...claim(a))).claim;
 const marker=join(state,'running');
 const script=`require('fs').writeFileSync(process.argv[1],'started');setTimeout(()=>{console.log(JSON.stringify({finished:Date.now()}))},500)`;
 const writer=run(state,...action('run',a,first.id),'--input',JSON.stringify({argv:[process.execPath,'-e',script,marker]}));
 for(let tries=0;tries<100;tries++){try{await readFile(marker);break;}catch{await new Promise(r=>setTimeout(r,10));}}
 const takeover=ok(state,...claim(b,'--take-over',first.id,'--reason','Concurrent handoff'));
 const [written,taken]=await Promise.all([writer,takeover]);
 assert.equal(written.code,0,written.error);
 assert.ok(Date.parse(taken.claim.claimedAt)>=written.data.finished);
}));


test('catalog uses honest temporary labels when no native title can be recovered', () => {
 const node={agent:'claude',runtimeUuid:a.split(':')[1],updatedAt:'2026-01-01',title:'',status:'quiet'};
 const graph={nodes:[node],roleClaims:[]};
 const item=catalogList(graph).sessions[0];
 assert.equal(item.title,'claude session 11111111'); assert.equal(item.titleSource,'unavailable');
 assert.equal(node.title,'', 'presentation fallback must not overwrite transcript evidence');
 node.title='First readable brief';
 assert.equal(catalogList(graph).sessions[0].titleSource,'native');
 node.catalogTitle='Explicit operator title';
 assert.equal(catalogList(graph).sessions[0].titleSource,'operator');
 assert.equal(catalogList(graph).sessions[0].title,'Explicit operator title');
});

 test('global controller is unique across projects and runtimes', () => fixture(async state => {
 const args = (session, project) => ['role','claim','--session',session,'--role','global-controller','--project',project];
 const first = await ok(state,...args(a,'global'));
 assert.equal(first.claim.key,'global-controller');
 assert.notEqual((await run(state,...args(b,'different'))).code,0);
 }));

test('only a fenced global controller maintains active Director leases', () => fixture(async state => {
 const director = (await ok(state,...claim(a))).claim;
 const ctl = (await ok(state,'role','claim','--session',b,'--role','global-controller','--project','global')).claim;
 const args = ['role','maintain','--session',b,'--role','global-controller','--project','global','--claim-id',ctl.id,'--input',JSON.stringify({projects:['example']})];
 assert.equal((await ok(state,...args)).maintained,1);
 await ok(state,...action('release',a,director.id));
 assert.equal((await ok(state,...args)).maintained,0);
 await ok(state,'role','release','--session',b,'--role','global-controller','--project','global','--claim-id',ctl.id);
 assert.notEqual((await run(state,...args)).code,0);
}));


test('catalog archive is explicit and independent from activity; freshness uses summary evidence', () => {
 const graph={nodes:[
  {agent:'codex',runtimeUuid:a.split(':')[1],title:'Quiet work',status:'quiet',surface:{archived:false},summary:'Testing',summarySource:'native-session',summaryUpdatedAt:'2026-09-01T10:00:00Z',lastActivityAt:'2026-09-01T11:00:00Z',lifecycle:{lastHumanAt:'2026-09-01T11:00:00Z'},updatedAt:'2026-09-02T12:00:00Z'},
  {agent:'codex',runtimeUuid:b.split(':')[1],title:'Archived work',status:'active',surface:{archived:true}},
  {agent:'claude',runtimeUuid:b.split(':')[1],title:'Unknown work',status:'closed'},
 ]};
 const rows=catalogList(graph).sessions;
 assert.equal(rows.length,2);
 const quiet=rows.find(row=>row.title==='Quiet work');
 assert.equal(quiet.archived,false); assert.equal(quiet.summary_freshness,'stale');
 assert.equal(quiet.summary_updated_at,'2026-09-01T10:00:00Z');
 assert.equal(rows.find(row=>row.title==='Unknown work').archived,null);
 assert.equal(catalogList(graph,{archive:'include'}).sessions.length,3);
 assert.deepEqual(catalogList(graph,{archive:'only'}).sessions.map(row=>row.title),['Archived work']);
 assert.equal(catalogList(graph,{title:'quiet'}).sessions.length,1);
});


test('incremental discovery collects an explicit native summary without refreshing unchanged evidence', async () => {
 const root=await mkdtemp(join(tmpdir(),'catalog-native-summary-'));
 try {
  const state=join(root,'graph'), id=a.split(':')[1];
  const transcript=join(root,`rollout-${id}.jsonl`);
  await writeFile(transcript,JSON.stringify({type:'session_meta',payload:{cwd:'/work/example'}})+'\n'+JSON.stringify({type:'event_msg',timestamp:'2026-10-01T10:00:00Z',payload:{type:'agent_message',message:'[[mesh-summary: Testing the cache fix.]]'}})+'\n');
  const env={...process.env,CODEX_SESSION_ROOT:root,CODEX_STATE_DB:join(root,'none.db'),MESH_DOMAIN_ROOTS_FILE:''};
  await exec(process.execPath,[bin,'--state',state,'discover','--agent','codex'],{env});
  let rows=(await ok(state,'catalog','list')).sessions;
  assert.equal(rows[0].summary,'Testing the cache fix.');
  assert.equal(rows[0].summary_source,'native-session');
  assert.equal(rows[0].last_activity_at,'2026-10-01T10:00:00Z');
  assert.equal(rows[0].summary_freshness,'current');
  assert.equal(rows[0].summary_updated_at,'2026-10-01T10:00:00Z');
  await exec(process.execPath,[bin,'--state',state,'discover','--agent','codex'],{env});
  rows=(await ok(state,'catalog','list')).sessions;
  assert.equal(rows[0].summary_updated_at,'2026-10-01T10:00:00Z');
 } finally {await rm(root,{recursive:true,force:true});}
});

test('explicit label-only catalog metadata never takes a claim from another runtime', () => fixture(async state => {
 const held=(await ok(state,...claim(a))).claim;
 await ok(state,'catalog','update','--session',b,'--role','director','--project','example','--label-only');
 const rows=(await ok(state,'catalog','list','--role','director')).sessions;
 assert.equal(rows.length,2);
 const claims=(await ok(state,'role','list')).claims;assert.equal(claims.length,1);assert.equal(claims[0].id,held.id);assert.equal(claims[0].session,a);
 assert.notEqual((await run(state,'catalog','update','--session',a,'--role','director','--project','other','--label-only')).code,0);
}));

test('cloud catalog labels are metadata-only, listed by role/project and replayable', () => fixture(async state => {
 const cloud='claude-cloud:fixture:session_CatalogFixture';
 await ok(state,'cloud','register','--session',cloud,'--evidence','fixture:cloud','--title','Initial cloud');
 const before=await ok(state,'show');const initial=before.nodes.find(n=>n.cloudIdentity);
 await ok(state,'catalog','register','--session',cloud,'--role','director','--project','example','--title','Cloud Director');
 await ok(state,'catalog','update','--session',cloud,'--status','waiting');
 const rows=(await ok(state,'catalog','list','--role','director','--project','example')).sessions;
 assert.equal(rows.length,1);assert.equal(rows[0].sessionId,cloud);assert.equal(rows[0].title,'Cloud Director');assert.equal(rows[0].status,'waiting');assert.equal(rows[0].sessionLink,undefined);
 const after=await ok(state,'show');const updated=after.nodes.find(n=>n.id===initial.id);
 for (const key of ['cloudIdentity','origin','agent','runtimeUuid','status','tmuxTarget','cwd','resumable']) assert.deepEqual(updated[key],initial[key],key);
 assert.deepEqual(after.roleClaims,before.roleClaims);
 assert.notEqual((await run(state,'role','claim','--session',cloud,'--role','director','--project','example')).code,0);
 assert.notEqual((await run(state,'catalog','update','--session',cloud,'--summary','Unsupported')).code,0);
 assert.notEqual((await run(state,'catalog','update','--session',cloud,'--cwd','/work/fixture')).code,0);
 assert.notEqual((await run(state,'catalog','register','--session','claude-cloud:fixture:session_AbsentFixture','--role','director','--project','example')).code,0);
 await rm(join(state,'checkpoint.json'));
 assert.deepEqual((await ok(state,'catalog','list','--role','director')).sessions,rows);
}));

test('catalog exposes stored link fields for native and cloud identities without fabricating them', () => {
 const sessionLink={link:'https://claude.ai/code/session_LinkFixture',status:'missing',lastKnown:true,checkedAt:'2026-01-01T00:00:00Z',reason:'not-public-row-field'};
 const graph={nodes:[{id:'native',agent:'claude',runtimeUuid:a.split(':')[1],sessionLink},
  {id:'cloud',agent:'claude',origin:'cloud',runtimeUuid:null,cloudIdentity:{provider:'claude-cloud',accountScope:'fixture',nativeId:'session_CloudFixture'},catalogRole:'director',catalogProject:'example',sessionLink:{...sessionLink,status:'ok',lastKnown:false}}]};
 const rows=catalogList(graph).sessions;assert.equal(rows.length,2);
 for(const row of rows){assert.deepEqual(Object.keys(row.sessionLink).sort(),['checkedAt','lastKnown','link','status']);assert.equal(row.sessionLink.checkedAt,sessionLink.checkedAt);}
 assert.equal(rows.find(r=>r.sessionId===a).sessionLink.lastKnown,true);
 assert.equal(catalogList(graph,{role:'director',project:'example'}).sessions[0].sessionLink.status,'ok');
});
