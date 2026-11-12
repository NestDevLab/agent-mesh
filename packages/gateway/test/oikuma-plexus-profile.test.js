import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import "./ts-extension-resolver.mjs";
const { createOikumaPlexusHandler } = await import("../src/mcp/oikuma-plexus-profile.ts");
const { CloudflareAccessAuthenticator, cloudflarePrincipalId, resolveCloudflareAccessPrincipal } = await import("../src/mcp/cloudflare-access.ts");
const { FixedWindowMeshMcpRateLimiter } = await import("../src/mcp/mesh-mcp.ts");

const issuer="https://access.example.test", audience="oikuma-test";
const selector="owner@example.test", owner=cloudflarePrincipalId("user",selector);
const grant={workspace_id:"workspace.test",ledger_refs:["work:TEST-1"],session_ids:[]};
const binding={kind:"user",selector,allowedTools:["mesh_plexus_work_items","mesh_plexus_ledger_sessions","mesh_send"],allowedAgentIds:[],allowedWorkspaceIds:["workspace.test"],allowedDomainIds:[],ledgerReadGrants:[grant]};
const request=(jwt,name="mesh_plexus_work_items",args={})=>new Request("http://localhost/oikuma",{method:"POST",headers:{"cf-access-jwt-assertion":jwt,"content-type":"application/json",accept:"application/json, text/event-stream","mcp-protocol-version":"2026-07-28","mcp-method":"tools/call","mcp-name":name},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args,_meta:{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{name:"test",version:"1"},"io.modelcontextprotocol/clientCapabilities":{}}}})});

test("user-only signed profile checks identity, permissions, expiry, scope and in-flight revocation", async t=>{
 const {publicKey,privateKey}=await generateKeyPair("ES256"), other=await generateKeyPair("ES256");
 const jwk={...await exportJWK(publicKey),kid:"test-key",alg:"ES256"};
 t.mock.method(globalThis,"fetch",async()=>Response.json({keys:[jwk]}));
 const now=Math.floor(Date.now()/1000);
 const sign=(changes={}, key=privateKey)=>new SignJWT({iss:issuer,aud:audience,sub:"test-user",email:selector,iat:now,exp:now+120,...changes}).setProtectedHeader({alg:"ES256",kid:"test-key"}).sign(key);
 let enabled=true,reads=0, release, entered;
 const enteredPromise=new Promise(r=>entered=r);
 let hold=false;
 const service={...binding,kind:"service",selector:"test-service",plexusLedgerReadDelegate:true,allowedTools:["mesh_plexus_work_items","mesh_plexus_ledger_sessions"]};
 const options={gateway:{},agents:[],rateLimiter:new FixedWindowMeshMcpRateLimiter(),
   resolvePrincipal:auth=>resolveCloudflareAccessPrincipal(auth,enabled?[binding,service]:[],owner),
   plexusLedgerReader:{async read(){reads++; if(hold){entered();await new Promise(r=>release=r)} return {items:[{ref:"work:TEST-1"}],refs:[],sessions:[],count:1};}}};
 const handler=createOikumaPlexusHandler(options,new CloudflareAccessAuthenticator({teamDomain:issuer,audience}));
 const token=await sign();
 const list=await handler.fetch(new Request("http://localhost/oikuma",{method:"POST",headers:{"cf-access-jwt-assertion":token,"content-type":"application/json",accept:"application/json, text/event-stream","mcp-protocol-version":"2026-07-28","mcp-method":"tools/list"},body:JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/list",params:{_meta:{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{name:"test",version:"1"},"io.modelcontextprotocol/clientCapabilities":{}}}})}));
 const listBody=await list.json();
 assert.ok(listBody.result, JSON.stringify(listBody));
 assert.deepEqual(listBody.result.tools.map(x=>x.name).sort(),["mesh_plexus_ledger_sessions","mesh_plexus_work_items"]);
 const ok=await handler.fetch(request(await sign()));
 assert.equal(ok.status,200);assert.match(await ok.text(),/work:TEST-1/);assert.equal(reads,1);
 const sessions=await handler.fetch(request(await sign(),"mesh_plexus_ledger_sessions",{ref:"work:TEST-1"}));
 assert.equal(sessions.status,200);assert.doesNotMatch(await sessions.text(),/isError/);assert.equal(reads,2);
 for(const jwt of [await sign({aud:"other-audience"}),await sign({iss:"https://wrong.example.test"}),await sign({exp:now-1}),await sign({exp:undefined}),await sign({},other.privateKey),await sign({email:"other@example.test"}),await sign({email:undefined,common_name:"test-service"})]){
   const response=await handler.fetch(request(jwt));assert.ok(response.status>=400);assert.equal(reads,2);
 }
 const unrelated=await handler.fetch(request(await sign(),"mesh_send",{}));
 assert.doesNotMatch(await unrelated.text(),/work:TEST-1/);assert.equal(reads,2);
 hold=true;const pending=handler.fetch(request(await sign()));await enteredPromise;enabled=false;release();
 const revoked=await pending;assert.equal(revoked.status,403);assert.doesNotMatch(await revoked.text(),/work:TEST-1/);
});
