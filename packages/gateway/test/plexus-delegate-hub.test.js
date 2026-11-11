import assert from "node:assert/strict";
import test from "node:test";
import "./ts-extension-resolver.mjs";
const {createMcpHubHandler} = await import("../src/mcp/hub-mcp.ts");
const {validateBinding} = await import("../src/mcp/serve.ts");

const reads = ["mesh_plexus_work_items", "mesh_plexus_ledger_sessions"];
const binding = () => ({kind:"service",selector:"example-service",plexusLedgerReadDelegate:true,
  allowedTools:[...reads],allowedAgentIds:[],allowedWorkspaceIds:["workspace.example"],allowedDomainIds:[],
  ledgerReadGrants:[{workspace_id:"workspace.example",ledger_refs:["work:EXAMPLE-1"],session_ids:[]}]});
const meta = {"io.modelcontextprotocol/protocolVersion":"2026-07-28",
  "io.modelcontextprotocol/clientInfo":{name:"delegate-hub-test",version:"1"},
  "io.modelcontextprotocol/clientCapabilities":{}};
for (const profile of ["workspace", "google-workspace", "memory"]) {
  test(`delegated service is confined on the ${profile} hub with shared audience identity`, async t => {
    const effects = {google:0,memory:0,status:0,plexus:0};
    // Deliberately inject broader accounts/tools to test the hub independently
    // of runtime-config validation. All profiles receive the same identity.
    const principal = {...binding(),id:"service",requesterId:"agent.service",allowedTools:[...reads,"mesh_send"]};
    const handler = createMcpHubHandler({profile,agents:[],gateway:{},rateLimiter:{consume:()=>true},
      googleRunner:{async run(){effects.google++;return {};},async readFile(){effects.google++;return {};}},
      memoryState:"ready",memoryRunner:{operatorComplete:true,async status(){effects.status++;return "ready";},
        async call(){effects.memory++;return {items:[]};}},
      plexusLedgerReader:{async read(operation){effects.plexus++;return operation === "items"
        ? {items:[],total:0,sort:["due:asc"]} : {refs:[],sessions:[]};}},
      resolvePrincipal:()=>({mesh:principal,allowedGoogleAccounts:["work","personal"]})});
    t.after(()=>handler.close());
    let sequence=0;
    const request=async(method,name,args={})=>{
      const response=await handler.fetch(new Request(`https://gateway.example.test/${profile}`,{
        method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",
          "mcp-protocol-version":"2026-07-28","mcp-method":method,...(name?{"mcp-name":name}:{})},
        body:JSON.stringify({jsonrpc:"2.0",id:++sequence,method,params:{_meta:meta,...(name?{name,arguments:args}:{})}})
      }),{authInfo:{token:"x",clientId:"same-service",scopes:[]}});
      return response.json();
    };
    const listed=await request("tools/list");
    if (listed.error) assert.equal(listed.error.code,-32601);
    assert.deepEqual((listed.result?.tools??[]).map(t=>t.name).sort(),profile==="workspace"?[...reads].sort():[]);
    for (const name of ["google_drive_search","google_gmail_search","memory_search","memory_read",
      "memory_backend_status","memory_propose","memory_proposal_status","documents_search","document_read",
      "document_upsert","document_delete","memory_status","mesh_send"]) {
      const denied=await request("tools/call",name,{query:"example",account:"work",id:"example"});
      assert.ok(denied.error || denied.result?.isError,`${profile}: ${name} must not succeed`);
    }
    for (const name of reads) {
      const result=await request("tools/call",name,{workspace_id:"workspace.example",...(name.endsWith("ledger_sessions")?{ref:"work:EXAMPLE-1"}:{})});
      if (profile==="workspace") {assert.equal(result.error,undefined);assert.notEqual(result.result?.isError,true);}
      else assert.ok(result.error || result.result?.isError);
    }
    assert.deepEqual(effects,{google:0,memory:0,status:0,plexus:profile==="workspace"?2:0});
    // Defense in depth when an injected principal bypasses the Access resolver.
    delete principal.plexusLedgerReadDelegate;
    const revoked=await request("tools/list");
    assert.deepEqual((revoked.result?.tools??[]).map(t=>t.name),[]);
    for(const name of [...reads,"memory_search","memory_backend_status","google_drive_search"]){
      const denied=await request("tools/call",name,{workspace_id:"workspace.example",ref:"work:EXAMPLE-1",query:"example"});
      assert.ok(denied.error || denied.result?.isError);
    }
    assert.deepEqual(effects,{google:0,memory:0,status:0,plexus:profile==="workspace"?2:0});
  });
}
test("delegate runtime binding rejects Google account grants, but permits an empty account list",()=>{
  assert.doesNotThrow(()=>validateBinding({...binding(),allowedGoogleAccounts:[]},0,[]));
  for (const accounts of [["work"],["personal"],["work","personal"]]) {
    assert.throws(()=>validateBinding({...binding(),allowedGoogleAccounts:accounts},0,[]),/Invalid MCP runtime binding/);
  }
});
