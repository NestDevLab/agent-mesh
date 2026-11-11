import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyLinks, successor } from '../bin/session-links.mjs';
const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
const node = (id, uuid = a, extra = {}) => ({ id, agent:'claude', runtimeUuid:uuid, catalogRole:'director', refs:[], status:'quiet', ...extra });
const event = (type, body) => ({type, ...body});
test('scope, successor chains, cycles and dangling successors', () => {
  const graph = {nodes:[node('a'), node('b',b)], renewals:[{from:`claude:${a}`,to:`claude:${b}`} ]};
  assert.equal(successor(graph,graph.nodes[0]).session, `claude:${b}`);
  graph.nodes[1].supersededBy = `claude:${a}`;
  assert.equal(successor(graph,graph.nodes[0]).error,'successor-cycle');
  graph.nodes.pop(); assert.equal(successor(graph,graph.nodes[0]).error,'successor-not-found');
});
test('dry-run is pure; apply records refs and timestamp without lifecycle mutation; repeat is ok', () => {
  const graph = {nodes:[node('a'),node('excluded',b,{catalogRole:'unclassified'})]};
  const observations = {[`claude:${a}`]:{status:'ok',link:'https://claude.ai/code/session_FixtureA',source:'claude-transcript'}};
  const before=JSON.stringify(graph);
  const dry=verifyLinks(graph,observations); assert.equal(dry.events.length,0); assert.equal(dry.result.results.length,1); assert.equal(JSON.stringify(graph),before);
  const applied=verifyLinks(graph,observations,{apply:true,at:'2026-01-01T00:00:00Z',makeEvent:event});
  const updated=applied.events[0].node; assert.equal(updated.status,'quiet'); assert.equal(updated.sessionLink.changedAt,'2026-01-01T00:00:00Z'); assert.deepEqual(updated.refs,['session-link:session_FixtureA']);
  assert.equal(verifyLinks({nodes:[updated]},observations).result.results[0].status,'ok');
  for (const status of ['missing','dead','archived']) assert.equal(verifyLinks(graph,{[`claude:${a}`]:{status}}).result.results[0].status,status);
});
test('native fixtures: transcript priority, pid liveness, Desktop archive, Codex thread checks and CLI replay', () => {
  const root=mkdtempSync(join(tmpdir(),'session-links-'));
  try {
    const transcripts=join(root,'projects'), metadata=join(root,'sessions'), desktop=join(root,'desktop'), db=join(root,'threads.sqlite');
    mkdirSync(join(transcripts,'fixture'),{recursive:true}); mkdirSync(metadata); mkdirSync(join(desktop,'account','project'),{recursive:true});
    const transcript=join(transcripts,'fixture',a+'.jsonl');
    writeFileSync(transcript, ['{"bridgeSessionId":"cse_Old","timestamp":"2026-01-01"}', '{"bridgeSessionId":"cse_New","timestamp":"2026-01-02"}'].join('\n'));
    writeFileSync(join(metadata,`${process.pid}.json`),JSON.stringify({pid:process.pid,sessionId:a,bridgeSessionId:'cse_Pid'}));
    const desktopPath=join(desktop,'account','project','local_fixture.json');
    writeFileSync(desktopPath,JSON.stringify({cliSessionId:a,bridgeSessionIds:['cse_Desktop'],isArchived:false}));
    const env={...process.env,CLAUDE_SESSION_ROOT:transcripts,CLAUDE_SESSION_METADATA_ROOT:metadata,CLAUDE_DESKTOP_SESSION_ROOT:desktop,CODEX_STATE_DB:db};
    const run=(sessions)=>{const p=spawnSync('python3',['bin/session-link-sources.py'],{cwd:new URL('..',import.meta.url),env,input:JSON.stringify(sessions),encoding:'utf8'});assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);};
    assert.match(run([`claude:${a}`])[`claude:${a}`].link,/session_New$/);
    rmSync(transcript); assert.equal(run([`claude:${a}`])[`claude:${a}`].source,'claude-pidfile');
    rmSync(join(metadata,`${process.pid}.json`)); assert.equal(run([`claude:${a}`])[`claude:${a}`].source,'claude-desktop');
    writeFileSync(desktopPath,JSON.stringify({cliSessionId:a,bridgeSessionIds:['cse_Desktop'],isArchived:true}));
    assert.equal(run([`claude:${a}`])[`claude:${a}`].status,'archived');
    assert.equal(run(['claude-cloud:fixture:session_Desktop'])['claude-cloud:fixture:session_Desktop'].status,'archived');
    const sql=spawnSync('python3',['-c',"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('create table threads(id text,archived integer)'); c.execute('insert into threads values (?,0)',(sys.argv[2],)); c.execute('insert into threads values (?,1)',(sys.argv[3],)); c.commit()",db,a,b]); assert.equal(sql.status,0);
    const values=run([`codex:${a}`,`codex:${b}`,'codex:33333333-3333-4333-8333-333333333333']);
    assert.equal(values[`codex:${a}`].status,'ok');assert.equal(values[`codex:${b}`].status,'archived');assert.equal(values['codex:33333333-3333-4333-8333-333333333333'].status,'dead');
    const state=join(root,'graph');mkdirSync(state);
    const n=node('node-fixture',a,{tmuxTarget:'fixture',cwd:'',roleProfile:'',title:'Fixture',summary:'',createdAt:'2026-01-01',updatedAt:'2026-01-01'});
    writeFileSync(join(state,'events.jsonl'),JSON.stringify({schema:'agent-mesh.session-graph-event.v1',id:'fixture',at:'2026-01-01',type:'node.upserted',node:n})+'\n');
    const cli=(args)=>{const p=spawnSync(process.execPath,['bin/mesh-graph.mjs','--state',state,...args],{cwd:new URL('..',import.meta.url),env,encoding:'utf8'});assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);};
    const original=readFileSync(join(state,'events.jsonl'),'utf8');cli(['links','verify','--json']);assert.equal(readFileSync(join(state,'events.jsonl'),'utf8'),original);
    cli(['links','verify','--apply','--json']);assert.equal(cli(['show','--json']).nodes[0].sessionLink.status,'archived');
    cli(['migrate','--apply','--json']);
    writeFileSync(desktopPath,JSON.stringify({cliSessionId:a,bridgeSessionIds:['cse_Desktop'],isArchived:false}));
    assert.equal(cli(['links','verify','--apply','--json']).results[0].status,'changed');
    assert.equal(cli(['links','verify','--apply','--json']).results[0].status,'ok');
    const replay=cli(['show','--json']);assert.deepEqual(replay.nodes[0].refs,['session-link:session_Desktop']);assert.equal(replay.links.filter(l=>l.until===null).length,1);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('migrated refs preserve other links and deduplicate duplicate runtime nodes', () => {
  const graph={migrated:true,nodes:[node('a'),node('duplicate')],links:[{session:`claude:${a}`,ref:'area:fixture',until:null}]};
  const report=verifyLinks(graph,{[`claude:${a}`]:{status:'ok',link:'https://claude.ai/code/session_Fixture'}},{apply:true,makeEvent:event});
  assert.equal(report.events.filter(e=>e.type==='link.opened').length,1);
  assert.equal(report.events.filter(e=>e.type==='link.closed').length,0);
});

test('explicit scope echoes capability and never observes or mutates another identity', () => {
  const graph={nodes:[node('a'),node('b',b)]};
  const session=`claude:${a}`;
  const report=verifyLinks(graph,{[session]:{status:'missing'}},{session,apply:true,makeEvent:event});
  assert.equal(report.result.session,session);assert.equal(report.result.results.length,1);assert.equal(report.events.length,1);assert.equal(report.events[0].node.id,'a');
  assert.throws(()=>verifyLinks(graph,{}, {session:'claude:33333333-3333-4333-8333-333333333333'}),/no classified/);
});
