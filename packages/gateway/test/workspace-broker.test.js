import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import "./ts-extension-resolver.mjs";
const { selectWorkspacePath } = await import("../src/mcp/workspace-path-policy.ts");
const { startWorkspaceBroker } = await import("../src/mcp/workspace-broker.ts");
const { WorkspaceWorkerRouter } = await import("../src/mcp/workspace-worker.ts");
const { MeshTaskCoordinator } = await import("../src/mcp/mesh-task-coordinator.ts");
const { MeshTaskStore } = await import("../src/mcp/mesh-task-store.ts");
const { MeshMcpFacade } = await import("../src/mcp/mesh-mcp.ts");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "mesh-broker-"));
  const cfg = { id: "broker.test", principalId: "owner", agentId: "agent.codex", workspaceId: "workspace.test", accessMode: "workspace-write", pathSelection: "client", provider: "codex", allowedRoots: ["/"], deniedRoots: [], codeRoot: resolve(new URL("../../..", import.meta.url).pathname), stateRoot: join(root,"state"), homeTemplate: join(root,"template"), socketPath: join(root,"control/broker.sock") };
  for (const p of [cfg.stateRoot,cfg.homeTemplate,dirname(cfg.socketPath),join(root,"project"),join(root,"other")]) await mkdir(p,{mode:0o700});
  t.after(()=>rm(root,{recursive:true,force:true}));
  return { root, cfg, destination:join(root,"project") };
}
function dirname(path) { return resolve(path,".."); }

test("client can select plain folders, but not system, credential, protected or escaping paths", async(t)=>{
  const {root,cfg,destination}=await fixture(t);
  assert.equal(selectWorkspacePath(destination,cfg,[cfg.codeRoot,cfg.stateRoot]),destination);
  await symlink(destination,join(root,"alias"));
  for(const path of ["/","/etc","/usr",cfg.stateRoot,join(root,"alias"),`${destination}/../project`]) assert.throws(()=>selectWorkspacePath(path,cfg,[cfg.stateRoot]),/denied/);
  assert.throws(()=>selectWorkspacePath(destination,{allowedRoots:[join(root,"other")],deniedRoots:[]},[]),/outside/);
});

test("client-selected path requires explicit policy and is immutable on session resume",async(t)=>{
  const {cfg,destination,root}=await fixture(t);
  const router=new WorkspaceWorkerRouter([cfg]);
  const store=new MeshTaskStore({stateDir:cfg.stateRoot});
  const coordinator=new MeshTaskCoordinator({store,execute:async()=>({text:"ok"})});
  const options={gateway:{},principal:{id:"owner",kind:"user",requesterId:"requester",allowedTools:["mesh_call","mesh_submit"],allowedAgentIds:["agent.codex"],allowedWorkspaceIds:["workspace.test"],allowedDomainIds:["domain.test"]},agents:[{id:"agent.codex",name:"Codex",provider:"codex"}],rateLimiter:{consume:()=>true},taskCoordinator:coordinator,workspaceWorkers:router};
  const facade=new MeshMcpFacade(options);
  const input={targetAgentId:"agent.codex",sessionMode:"fresh",workspacePath:destination,accessMode:"workspace-write",message:"change",idempotencyKey:"first"};
  const {task}=await facade.callTask(input,1000);
  assert.equal(task.workspace_path,destination);
  const follow=await facade.callTask({targetAgentId:"agent.codex",sessionId:task.session_id,message:"test",idempotencyKey:"next"},1000);
  assert.equal(follow.task.workspace_path,destination);
  await assert.rejects(facade.submitTask({...input,sessionMode:undefined,sessionId:task.session_id,workspacePath:join(root,"other"),idempotencyKey:"bad"}),/immutable/);
  await assert.rejects(facade.submitTask({...input,workspacePath:undefined,idempotencyKey:"no-path"}),/workspace_path_required/);
  const denied=new MeshMcpFacade({...options,workspaceWorkers:new WorkspaceWorkerRouter([{...cfg,pathSelection:undefined}])});
  await assert.rejects(denied.submitTask({...input,idempotencyKey:"no-grant"}),/workspace_path_denied/);
});

test("broker launches a real isolated worker for a plain folder and rejects protected paths before launch",async(t)=>{
  const {cfg,destination}=await fixture(t);
  const broker=await startWorkspaceBroker(cfg); t.after(()=>broker.close());
  const router=new WorkspaceWorkerRouter([cfg]);
  const task={schema:"agent-mesh.mcp-task.v1",task_id:"task-test",message_id:"m",context_id:"c",principal_id:cfg.principalId,target_agent_id:cfg.agentId,workspace_id:cfg.workspaceId,workspace_path:destination,access_mode:cfg.accessMode,worker_id:cfg.id,session_id:"11111111-1111-4111-8111-111111111111",message:"test",labels:[],idempotency_key:"first"};
  await assert.rejects(router.execute(task,{bindSession:async()=>{}}),/Session is not owned/);
  assert.equal((await readdir(cfg.stateRoot)).length,1);
  await assert.rejects(router.execute({...task,task_id:"blocked",workspace_path:"/etc"},{bindSession:async()=>{}}),/workspace_path_denied/);
  assert.equal((await readdir(cfg.stateRoot)).length,1);
});

test("a selected directory with shell metacharacters is mounted at a fixed path without interpolation",async(t)=>{
  const {cfg,root}=await fixture(t);
  const destination=join(root,'project with $(printf injected) "quotes"'); await mkdir(destination,{mode:0o700});
  const {sandboxArguments}=await import("../src/mcp/workspace-sandbox.ts");
  const {spawnSync}=await import("node:child_process");
  const home=join(root,"worker-home"),temporary=join(root,"worker-tmp");await mkdir(home,{mode:0o700});await mkdir(temporary,{mode:0o700});
  const args=sandboxArguments({repository:destination,codeRoot:cfg.codeRoot,home,temporary,accessMode:"workspace-write",mountPath:"/workspace"},process.execPath,["-e","require('fs').writeFileSync('/workspace/probe','ok')"]);
  const result=spawnSync('/usr/bin/bwrap',args,{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  const {readFile}=await import("node:fs/promises");assert.equal(await readFile(join(destination,"probe"),'utf8'),'ok');
});

test("provider auth is an individual read-only file and its source home is not exposed",async(t)=>{
  const {cfg,root,destination}=await fixture(t);
  const {writeFile,readFile}=await import('node:fs/promises');
  const {spawnSync}=await import('node:child_process');
  const {sandboxArguments}=await import('../src/mcp/workspace-sandbox.ts');
  const auth=join(root,'approved-auth.json');await writeFile(auth,'demo',{mode:0o600});
  const home=join(root,'auth-home'),temporary=join(root,'auth-tmp');await mkdir(home,{mode:0o700});await mkdir(temporary,{mode:0o700});
  const script=`const fs=require('fs');if(fs.readFileSync('/home/worker/.codex/auth.json','utf8')!=='demo')throw Error('missing auth');try{fs.writeFileSync('/home/worker/.codex/auth.json','changed');throw Error('auth writable')}catch(e){if(e.message==='auth writable')throw e;}if(fs.existsSync(${JSON.stringify(auth)}))throw Error('source exposed');`;
  const args=sandboxArguments({repository:destination,codeRoot:cfg.codeRoot,home,temporary,accessMode:'workspace-write',readOnlyFiles:[{source:auth,target:'.codex/auth.json'}]},process.execPath,['-e',script]);
  const result=spawnSync('/usr/bin/bwrap',args,{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(await readFile(auth,'utf8'),'demo');
});
