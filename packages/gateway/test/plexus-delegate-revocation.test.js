import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import "./ts-extension-resolver.mjs";
const {createMcpHubHandler}=await import("../src/mcp/hub-mcp.ts");
const {createMeshMcpHandler}=await import("../src/mcp/mesh-mcp.ts");
const {readRuntimeConfig,validateBinding}=await import("../src/mcp/serve.ts");
const {resolveCloudflareAccessPrincipal,resolveCloudflareAccessBinding}=await import("../src/mcp/cloudflare-access.ts");
const tools=["mesh_plexus_work_items","mesh_plexus_ledger_sessions"];
const binding=()=>({kind:"service",selector:"example-service",plexusLedgerReadDelegate:true,allowedTools:[...tools],
  allowedAgentIds:[],allowedWorkspaceIds:["workspace.example"],allowedDomainIds:[],
  ledgerReadGrants:[{workspace_id:"workspace.example",ledger_refs:["work:EXAMPLE-1"],session_ids:[]}]});
const unrelated={kind:"user",selector:"other@example.test",allowedTools:[],allowedAgentIds:[],allowedWorkspaceIds:[],allowedDomainIds:[]};
const authInfo={token:"x",clientId:"same-service",scopes:[],extra:{cloudflareAccessIdentity:{kind:"service",subject:"same-subject",selector:"example-service"}}};
const meta={"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{name:"revocation-test",version:"1"},"io.modelcontextprotocol/clientCapabilities":{}};
for(const profile of ["agent-mesh","workspace","google-workspace","memory"]) {
  test(`same verified credential loses access after flag revocation and binding removal: ${profile}`,async t=>{
    const root=await mkdtemp(join(tmpdir(),"plexus-revoke-")),file=join(root,"bindings-fixture.json");
    t.after(()=>rm(root,{recursive:true,force:true}));
    const current=binding(),config={stateDir:root,agents:[],contexts:[],bindings:[current,unrelated]};
    const save=()=>writeFile(file,JSON.stringify(config));await save();
    const effects={google:0,memory:0,status:0,plexus:0};
    const common={gateway:{},agents:[],rateLimiter:{consume:()=>true},plexusLedgerReader:{async read(operation){effects.plexus++;return operation==="items"?{items:[],total:0,sort:["due:asc"]}:{refs:[],sessions:[]};}}};
    const handler=profile==="agent-mesh"?createMeshMcpHandler({...common,resolvePrincipal:async auth=>resolveCloudflareAccessPrincipal(auth,(await readRuntimeConfig(file)).bindings)}):createMcpHubHandler({...common,profile,
      googleRunner:{async run(){effects.google++;return {};},async readFile(){effects.google++;return {};}},
      memoryState:"ready",memoryRunner:{operatorComplete:true,async status(){effects.status++;return "ready";},async call(){effects.memory++;return {}; }},
      resolvePrincipal:async auth=>{const {bindings}=await readRuntimeConfig(file);const bound=resolveCloudflareAccessBinding(auth,bindings);return {mesh:resolveCloudflareAccessPrincipal(auth,bindings),allowedGoogleAccounts:bound.allowedGoogleAccounts??[]};}});
    t.after(()=>handler.close());let id=0;
    const request=async(method,name,args={})=>{
      const r=await handler.fetch(new Request(`https://gateway.example.test/${profile}`,{method:"POST",
        headers:{"content-type":"application/json",accept:"application/json, text/event-stream","mcp-protocol-version":"2026-07-28","mcp-method":method,...(name?{"mcp-name":name}:{})},
        body:JSON.stringify({jsonrpc:"2.0",id:++id,method,params:{_meta:meta,...(name?{name,arguments:args}:{})}})}),{authInfo});return {status:r.status,body:await r.json()};};
    const first=await request("tools/list");
    if(["agent-mesh","workspace"].includes(profile)) assert.equal(first.status,200);
    else {assert.ok([200,404].includes(first.status));if(first.body.error)assert.equal(first.body.error.code,-32601);}
    assert.deepEqual((first.body.result?.tools??[]).map(x=>x.name).sort(),["agent-mesh","workspace"].includes(profile)?[...tools].sort():[]);
    if(["agent-mesh","workspace"].includes(profile))for(const name of tools){const r=await request("tools/call",name,{workspace_id:"workspace.example",...(name===tools[1]?{ref:"work:EXAMPLE-1"}:{})});assert.equal(r.body.error,undefined);assert.notEqual(r.body.result?.isError,true);}
    const baseline={...effects};
    delete current.plexusLedgerReadDelegate;await save();
    // Configuration remains valid; only authorization of this service changes.
    assert.deepEqual((await readRuntimeConfig(file)).bindings[0],current);
    for(const mode of ["flag removed","binding removed"]){
      if(mode==="binding removed"){config.bindings=[unrelated];await save();assert.equal((await readRuntimeConfig(file)).bindings.length,1);}
      const listed=await request("tools/list");assert.equal(listed.status,403,mode);
      for(const name of [...tools,"memory_search","memory_read","memory_backend_status","memory_propose","document_delete","google_drive_search"]){
        const denied=await request("tools/call",name,{workspace_id:"workspace.example",ref:"work:EXAMPLE-1",query:"example"});assert.equal(denied.status,403,`${mode}: ${name}`);}
      assert.deepEqual(effects,baseline);assert.equal(effects.memory+effects.status+effects.google,0);
      // Removing this binding must not invalidate the other, unrelated identity.
      const other={extra:{cloudflareAccessIdentity:{kind:"user",subject:"other",selector:unrelated.selector}}};
      assert.equal(resolveCloudflareAccessPrincipal(other,(await readRuntimeConfig(file)).bindings).kind,"user");
    }
  });
}
test("Plexus service scope survives absent or empty grants/tools after disabling the flag",()=>{
  for(const change of [{ledgerReadGrants:[]},{ledgerReadGrants:undefined},{allowedTools:[]},{allowedTools:[],ledgerReadGrants:[]}]){
    const current={...binding(),...change};delete current.plexusLedgerReadDelegate;
    assert.doesNotThrow(()=>validateBinding(current,0,[]));
    assert.throws(()=>resolveCloudflareAccessPrincipal(authInfo,[current]),/Plexus service delegation is disabled/);
    assert.throws(()=>validateBinding({...current,allowedGoogleAccounts:["work"]},0,[]),/Invalid MCP runtime binding/);
  }
});
