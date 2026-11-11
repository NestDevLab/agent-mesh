import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, mkdtemp, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import "./ts-extension-resolver.mjs";
const { ShellPlexusLedgerReader, validLedgerReadGrants, registerPlexusLedgerTools } = await import("../src/mcp/plexus-ledger.ts");
const { validItemRef } = await import("../src/mcp/item-ref.ts");
const { resolveCloudflareAccessPrincipal } = await import("../src/mcp/cloudflare-access.ts");
const bridgeRoot = fileURLToPath(new URL("../../tmux-bridge/bin/", import.meta.url));
const native = "11111111-1111-4111-8111-111111111111";
const hidden = "22222222-2222-4222-8222-222222222222";
const local = `codex:${native}`;
const cloud = "claude-cloud:test:cse_SYNTHETIC";
const refs = Array.from({ length: 671 }, (_, i) => `work:ITEM-${String(i + 1).padStart(4, "0")}`);
function harness(overrides = {}) {
  const grant = { workspace_id: "workspace.test", ledger_refs: [...refs], session_ids: [local, cloud], group_refs: ["group:visible"] };
  const graph = { migrated: true, lastSeq: 7, nodes: [
    { id: "local", agent: "codex", runtimeUuid: native, title: "Visible", updatedAt: "2030-01-01T00:00:00Z", domains: [] },
    { id: "hidden", agent: "codex", runtimeUuid: hidden, title: "Hidden", updatedAt: "2030-01-01T00:00:00Z", domains: [] },
    { id: "cloud", agent: "claude", origin: "cloud", title: "Cloud", cloudIdentity: { provider: "claude-cloud", accountScope: "test", nativeId: "cse_SYNTHETIC" }, domains: [] }
  ], links: [
    { id: "one", session: local, ref: refs[0], role: "owns", until: null },
    { id: "two", session: `codex:${hidden}`, ref: refs[0], role: "works-on", until: null },
    { id: "three", session: cloud, ref: refs[0], role: "works-on", until: null },
    { id: "four", session: local, ref: "group:visible", role: "discusses", until: null },
    { id: "five", session: local, ref: "group:hidden", role: "discusses", until: null }
  ] };
  const items = refs.map((ref, i) => ({ ref, title: `Item ${i}`, status: "open", updatedAt: "2030-01-01T00:00:00Z", sourceRevision: "sha256:" + "a".repeat(64), fields: {
    blank: "", long: "x".repeat(600), due: i === 0 ? "" : "2030-01-01", priority: i === 1 ? "high" : "normal", size: "small", custom: String(i)
  }, sortKeys: { priority: i === 1 ? 0 : 1, size: 1 } }));
  items.push({ ref: "work:OUTSIDE", title: "Hidden item", status: "open", fields: { ref: refs[0], custom: "unauthorized" } });
  const calls = [];
  const reader = new ShellPlexusLedgerReader({ bridgeRoot }, async (file, args, input) => {
    calls.push({ file, args, input });
    const allowed = input ? JSON.parse(input).refs : [];
    return args.includes("show") ? JSON.stringify(graph) : JSON.stringify({ items: items.filter(i => allowed.includes(i.ref)), missing: [], errors: [] });
  });
  const principal = { id: "principal", kind: "user", plexusLedgerOwner: true, requesterId: "requester", allowedTools: ["mesh_plexus_work_items", "mesh_plexus_ledger_sessions"],
    allowedWorkspaceIds: ["workspace.test"], allowedDomainIds: [], allowedAgentIds: [], ledgerReadGrants: [grant], ...overrides };
  const handlers = new Map();
  const options = { principal, plexusLedgerReader: reader, rateLimiter: { consume: () => true } };
  registerPlexusLedgerTools({ registerTool(name, config, handler) { handlers.set(name, { config, handler }); } }, options);
  const invoke = async (name, input = {}) => {
    const result = await handlers.get(name).handler(input);
    return result.isError ? result : JSON.parse(result.content[0].text);
  };
  return { grant, graph, items, calls, reader, principal, options, handlers, invoke };
}

test("static exact read grants admit all 671 refs without workspace sharding", () => {
  const h = harness();
  assert.equal(validLedgerReadGrants([h.grant], ["workspace.test"]), true);
  assert.equal(validLedgerReadGrants([h.grant, h.grant], ["workspace.test"]), false);
  assert.equal(validLedgerReadGrants([h.grant], ["other"]), false);
  assert.equal(validLedgerReadGrants([{ ...h.grant, ledger_refs: ["work:with space"] }], ["workspace.test"]), false);
  assert.equal(validLedgerReadGrants([{ ...h.grant, ledger_refs: ["work:" + "x".repeat(508)] }], ["workspace.test"]), false);
});

test("pages cover more than 200 refs once with core default sort and blanks last", async () => {
  const h = harness(), seen = [];
  let cursor;
  do {
    const result = await h.invoke("mesh_plexus_work_items", { limit: 200, cursor });
    assert.equal(result.total, 671);
    assert.deepEqual(result.sort, ["due:asc", "priority:asc", "size:asc"]);
    seen.push(...result.items.map(i => i.ref));
    cursor = result.next_cursor;
  } while (cursor);
  assert.equal(seen.length, 671);
  assert.equal(new Set(seen).size, 671);
  assert.equal(seen[0], refs[1]);
  assert.equal(seen.at(-1), refs[0]);
  assert.ok(h.calls.every(c => c.args.includes("show") || c.args[0] === "-c"));
  assert.ok(h.calls.filter(c => c.input).every(c => JSON.parse(c.input).refs.every(ref => h.grant.ledger_refs.includes(ref))));
});

test("user predicates and sort are delegated to core after exact ref authorization", async () => {
  const h = harness();
  const missing = await h.invoke("mesh_plexus_work_items", { filter: { custom: "unauthorized" } });
  assert.equal(missing.total, 0);
  const sorted = await h.invoke("mesh_plexus_work_items", { sort: ["custom:desc"], filter: { custom: { in: ["9", "10"] } } });
  assert.deepEqual(sorted.items.map(i => i.fields.custom), ["10", "9"]);
});

test("links never confer session or group visibility", async () => {
  const h = harness();
  const result = await h.invoke("mesh_plexus_work_items", { filter: { id: { exists: false } }, sort: ["custom:asc"] });
  const row = result.items.find(i => i.ref === refs[0]);
  assert.deepEqual(row.sessions.map(s => s.nativeId).sort(), [native, "cse_SYNTHETIC"].sort());
  assert.deepEqual(row.groups, ["group:visible"]);
  assert.ok(row.sessions.find(s => s.nativeId === "cse_SYNTHETIC").url.endsWith("session_SYNTHETIC"));
  const sessions = await h.invoke("mesh_plexus_ledger_sessions", { ref: refs[0] });
  assert.deepEqual(sessions.sessions.map(s => s.nativeId).sort(), [native, "cse_SYNTHETIC"].sort());
  assert.ok(sessions.sessions.every(s => !Object.hasOwn(s, "host") && !Object.hasOwn(s, "cwd")));
  h.grant.session_ids = [];
  assert.deepEqual((await h.invoke("mesh_plexus_ledger_sessions", { ref: refs[0] })).sessions, []);
});

test("grant revocation rejects the old cursor and direct ref before source access", async () => {
  const h = harness();
  const first = await h.invoke("mesh_plexus_work_items", { limit: 200 });
  h.grant.ledger_refs = h.grant.ledger_refs.slice(1);
  assert.equal((await h.invoke("mesh_plexus_work_items", { limit: 200, cursor: first.next_cursor })).isError, true);
  const count = h.calls.length;
  assert.equal((await h.invoke("mesh_plexus_ledger_sessions", { ref: refs[0] })).isError, true);
  assert.equal(h.calls.length, count);
  assert.equal((await h.invoke("mesh_plexus_work_items", { workspace_id: "other" })).isError, true);
  assert.equal(h.calls.length, count);
});

test("forged, cross-principal and source-stale cursors fail closed", async () => {
  const h = harness();
  const first = await h.invoke("mesh_plexus_work_items", { limit: 200 });
  assert.equal((await h.invoke("mesh_plexus_work_items", { cursor: "invalid" })).isError, true);
  h.principal.id = "other-principal";
  assert.equal((await h.invoke("mesh_plexus_work_items", { cursor: first.next_cursor })).isError, true);
  h.principal.id = "principal";
  h.items[0].title = "Changed";
  assert.equal((await h.invoke("mesh_plexus_work_items", { cursor: first.next_cursor })).isError, true);
});

test("Cloudflare principal receives an independent copy of static read grants", () => {
  const h = harness();
  const binding = { ...h.principal, kind: "user", selector: "operator@example.test" };
  const principal = resolveCloudflareAccessPrincipal({ extra: { cloudflareAccessIdentity: { kind: "user", subject: "example", selector: binding.selector } } }, [binding]);
  h.grant.ledger_refs.length = 0;
  assert.equal(principal.ledgerReadGrants[0].ledger_refs.length, 671);
});

test("reader and grant absence are denied without touching the source", async () => {
  const h = harness();
  h.options.plexusLedgerReader = undefined;
  assert.equal((await h.invoke("mesh_plexus_work_items")).isError, true);
  assert.equal(h.calls.length, 0);
});

test("HTTP tool boundary rejects caller scope injection and rechecks revoked grants", async () => {
  const { createMeshMcpHandler } = await import("../src/mcp/mesh-mcp.ts");
  const h = harness();
  const handler = createMeshMcpHandler({ ...h.options, gateway: {}, agents: [], resolvePrincipal: () => h.principal });
  const call = async (args) => {
    const response = await handler.fetch(new Request("https://mcp.example.test/mcp", {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "mesh_plexus_work_items" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name: "mesh_plexus_work_items", arguments: args, _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "plexus-test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {} }
      } })
    }), { authInfo: { token: "t", clientId: "fixture", scopes: [] } });
    const body = await response.json();
    return body.result ?? { isError: true };
  };
  const first = await call({ limit: 200 });
  assert.equal(first.isError, undefined);
  const page = JSON.parse(first.content[0].text);
  const count = h.calls.length;
  assert.equal((await call({ limit: 200, scope: { ledger_refs: ["work:OUTSIDE"] } })).isError, true);
  assert.equal(h.calls.length, count);
  h.principal.plexusLedgerOwner = false;
  assert.equal((await call({})).isError, true);
  assert.equal(h.calls.length, count);
  h.principal.plexusLedgerOwner = true;
  h.principal.ledgerReadGrants = [];
  assert.equal((await call({ cursor: page.next_cursor })).isError, true);
  assert.equal(h.calls.length, count);
});


test("shared Unicode 15 reference fixtures and code-point boundaries", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/item-ref-v1.json", import.meta.url), "utf8"));
  for (const ref of fixture.valid) assert.equal(validItemRef(ref), true, ref);
  for (const ref of fixture.invalid) assert.equal(validItemRef(ref), false, JSON.stringify(ref));
  for (const ref of ["work.test:item", "work+v1:item", "work:café", "work:" + "x".repeat(300), "work:" + "💻".repeat(507)]) {
    assert.equal(validItemRef(ref), true);
    assert.equal(validLedgerReadGrants([{ workspace_id: "workspace.test", ledger_refs: [ref], session_ids: [] }], ["workspace.test"]), true);
  }
  assert.equal(validItemRef("work:" + "💻".repeat(508)), false);
});

test("exact source query preserves long and empty fields through core filters", async () => {
  const h = harness();
  const result = await h.invoke("mesh_plexus_work_items", { filter: { long: "x".repeat(600) }, limit: 1 });
  assert.equal(result.total, 671);
  assert.equal(result.items[0].fields.long.length, 600);
  assert.equal(result.items[0].fields.blank, "");
  assert.match(result.items[0].sourceRevision, /^sha256:/);
});

test("real protocol dispatcher batches only exact authorized refs per scheme", async t => {
  const h = harness();
  const root = await mkdtemp(join(tmpdir(), "plexus-exact-query-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = join(root, "adapter.mjs"), config = join(root, "adapters.json"), log = join(root, "calls.jsonl");
  await writeFile(adapter, `import { appendFileSync } from 'node:fs';
let text='';for await(const part of process.stdin)text+=part;const request=JSON.parse(text);
const operation=process.argv.at(-1),scheme=process.argv[2];
appendFileSync(process.env.QUERY_FIXTURE_LOG,JSON.stringify({operation,scheme,refs:request.refs||[]})+'\\n');
if(operation==='capabilities'){console.log(JSON.stringify({schema:'agent-mesh.ledger-adapter.v1',operations:['query']}));}
else if(operation==='query'){
if(request.refs.length>200||request.refs.some(ref=>!ref.startsWith(scheme+':')||ref==='work:OUTSIDE'))throw Error('unauthorized malformed record reached');
console.log(JSON.stringify({schema:'agent-mesh.ledger-adapter.v1',items:request.refs.map(ref=>({ref,title:'Exact item',status:'open',updatedAt:'2030-01-01T00:00:00Z',sourceRevision:'sha256:'+'a'.repeat(64),fields:{long:'x'.repeat(600),blank:''}})),missing:[],errors:[]}));
}else throw Error('broad operation forbidden');`);
  await writeFile(config, JSON.stringify({ schemaVersion: 1, adapters: ["work", "other"].map(scheme => ({ scheme, command: [process.execPath, adapter, scheme] })) }));
  const real = promisify(execFile);
  const reader = new ShellPlexusLedgerReader({ bridgeRoot }, async (file, args, input) => {
    if (args.includes("show")) return JSON.stringify(h.graph);
    const pending = real(file, args, { env: { ...process.env, MESH_LEDGERS_FILE: config, QUERY_FIXTURE_LOG: log, PYTHONDONTWRITEBYTECODE: "1" }, maxBuffer: 16 * 1024 * 1024 });
    pending.child.stdin.end(input);
    return (await pending).stdout;
  });
  const grant = { ...h.grant, ledger_refs: [...refs, "other:café"] };
  const result = await reader.read("items", { include_closed: true }, grant);
  assert.equal(result.total, 672);
  assert.ok(result.items.every(i => i.fields.long.length === 600 && i.fields.blank === ""));
  const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  const queried = calls.filter(c => c.operation === "query");
  assert.deepEqual(queried.map(c => c.refs.length), [200, 200, 200, 71, 1]);
  assert.ok(calls.every(c => ["capabilities", "query"].includes(c.operation)));
  assert.ok(queried.every(c => c.refs.every(ref => ref.startsWith(c.scheme + ":") && grant.ledger_refs.includes(ref))));
});


test("malformed source scalars fail closed and generated file locations stay private", async () => {
  for (const value of [String.fromCharCode(0xd800), String.fromCharCode(0xdc00), { nested: true }]) {
    const h = harness();
    h.items[0].fields.long = value;
    assert.equal((await h.invoke("mesh_plexus_work_items")).isError, true);
  }
  const h = harness();
  h.items[0].url = "/storage/private/item.md";
  const result = await h.invoke("mesh_plexus_work_items", { sort: ["custom:asc"] });
  assert.equal(result.items[0].url, null);
});


for (const mode of ["schemes", "batches", "duplicate-missing", "foreign-error"]) {
  test(`real dispatcher rejects provider attribution attack (${mode}) before aggregation`, async t => {
    const h = harness();
    const root = await mkdtemp(join(tmpdir(), "plexus-provider-scope-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const script = join(root, "adapter.mjs"), config = join(root, "config.json"), log = join(root, "log.jsonl");
    await writeFile(script, `import {appendFileSync} from 'node:fs';let input='';for await(const p of process.stdin)input+=p;
const req=JSON.parse(input),op=process.argv.at(-1),scheme=process.argv[2],mode=process.argv[3];
appendFileSync(process.env.QUERY_FIXTURE_LOG,JSON.stringify({op,scheme})+'\\n');
if(op==='capabilities')console.log(JSON.stringify({schema:'agent-mesh.ledger-adapter.v1',operations:['query']}));
else{let refs=[...req.refs],missing=[],errors=[];
if(mode==='schemes')refs=refs.map(r=>r.startsWith('a:')?'b:item':'a:item');
if(mode==='batches')refs=refs.map(r=>r==='a:0'?'a:200':r==='a:200'?'a:0':r);
if(mode==='duplicate-missing'){missing=[req.refs[0],req.refs[0]];refs=[];}
if(mode==='foreign-error'){errors=[{ref:'b:item'}];refs=[];}
console.log(JSON.stringify({schema:'agent-mesh.ledger-adapter.v1',items:refs.map(ref=>({ref,title:'Exact item',status:'open',updatedAt:'2030-01-01T00:00:00Z',fields:{source:scheme},sourceRevision:'sha256:'+'a'.repeat(64)})),missing,errors}));}`);
    await writeFile(config, JSON.stringify({ schemaVersion: 1, adapters: ["a", "b"].map(scheme => ({ scheme, command: [process.execPath, script, scheme, mode] })) }));
    const real = promisify(execFile);
    const reader = new ShellPlexusLedgerReader({ bridgeRoot }, async (file, args, input) => {
      if (args.includes("show")) return JSON.stringify(h.graph);
      const pending = real(file, args, { env: { ...process.env, MESH_LEDGERS_FILE: config, QUERY_FIXTURE_LOG: log, PYTHONDONTWRITEBYTECODE: "1" } });
      pending.child.stdin.end(input);
      return (await pending).stdout;
    });
    const grant = { ...h.grant, ledger_refs: mode === "batches" ? Array.from({ length: 201 }, (_, i) => `a:${i}`) : ["a:item", "b:item"] };
    await assert.rejects(reader.read("items", {}, grant));
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(calls.filter(c => c.op === "query").length, 1);
  });
}


for (const byteLimit of [1048576, 33000]) {
  test(`real dispatcher respects serialized byte limit for 512-code-point refs (${byteLimit})`, async t => {
    const h = harness();
    const root = await mkdtemp(join(tmpdir(), "plexus-payload-boundary-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const script = join(root, "adapter.mjs"), config = join(root, "config.json"), log = join(root, "calls.jsonl");
    await writeFile(script, `import {appendFileSync} from 'node:fs';let text='';for await(const part of process.stdin)text+=part;
const request=JSON.parse(text),operation=process.argv.at(-1),limit=Number(process.argv[2]);
if(operation==='capabilities')console.log(JSON.stringify({schema:'agent-mesh.ledger-adapter.v1',operations:['query'],maxRequestBytes:limit}));
else{const bytes=Buffer.byteLength(text);if(bytes>limit||request.refs.length>200)throw Error('payload over adapter limit');
appendFileSync(process.env.QUERY_FIXTURE_LOG,JSON.stringify({bytes,refs:request.refs})+'\\n');
console.log(JSON.stringify({schema:'agent-mesh.ledger-adapter.v1',items:request.refs.map(ref=>({ref,title:'Exact item',status:'open',updatedAt:'2030-01-01T00:00:00Z',fields:{},sourceRevision:'sha256:'+'a'.repeat(64)})),missing:[],errors:[]}));}`);
    await writeFile(config, JSON.stringify({ schemaVersion: 1, adapters: [{ scheme: "w", command: [process.execPath, script, String(byteLimit)], maxRequestBytes: byteLimit }] }));
    const real = promisify(execFile);
    const reader = new ShellPlexusLedgerReader({ bridgeRoot }, async (file, args, input) => {
      if (args.includes("show")) return JSON.stringify(h.graph);
      const pending = real(file, args, { env: { ...process.env, MESH_LEDGERS_FILE: config, QUERY_FIXTURE_LOG: log, PYTHONDONTWRITEBYTECODE: "1" }, maxBuffer: 16 * 1024 * 1024 });
      pending.child.stdin.end(input);
      return (await pending).stdout;
    });
    const astral = Array.from({ length: 200 }, (_, i) => "w:" + String(i).padStart(3, "0") + "💻".repeat(507));
    assert.ok(astral.every(ref => Array.from(ref).length === 512 && validItemRef(ref)));
    const grant = { ...h.grant, ledger_refs: astral };
    const result = await reader.read("items", { include_closed: true }, grant);
    assert.equal(result.total, 200);
    assert.deepEqual(new Set(result.items.map(i => i.ref)), new Set(astral));
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(calls.length > 1);
    assert.ok(calls.every(c => c.bytes <= byteLimit && c.refs.length <= 200));
    assert.deepEqual(calls.flatMap(c => c.refs), astral);
  });
}

async function largeResponseFixture(t, count, maxResultBytes) {
  const root = await mkdtemp(join(tmpdir(), "plexus-response-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copyFile(join(bridgeRoot, "mesh-ledger.py"), join(root, "mesh-ledger.py"));
  await writeFile(join(root, "plexus.mjs"), `export * from ${JSON.stringify(pathToFileURL(join(bridgeRoot, "plexus.mjs")).href)};`);
  await writeFile(join(root, "mesh-graph.mjs"), 'console.log(JSON.stringify({nodes:[],links:[],lastSeq:1}));');
  const script = join(root, "adapter.mjs"), config = join(root, "config.json"), log = join(root, "calls.jsonl");
  await writeFile(script, `import {appendFileSync} from 'node:fs';let text='';for await(const part of process.stdin)text+=part;
const request=JSON.parse(text),op=process.argv.at(-1);
if(op==='capabilities')console.log(JSON.stringify({schema:'agent-mesh.ledger-adapter.v1',operations:['query']}));
else{appendFileSync(process.env.QUERY_FIXTURE_LOG,JSON.stringify(request.refs)+'\\n');
const items=request.refs.map(ref=>({ref,title:'Exact item',status:'open',updatedAt:'2030-01-01T00:00:00Z',sourceRevision:'sha256:'+'a'.repeat(64),fields:{long:'x'.repeat(3900),other:'y'.repeat(2100)}}));
console.log(JSON.stringify({schema:'agent-mesh.ledger-adapter.v1',items,missing:[],errors:[]}));}`);
  await writeFile(config, JSON.stringify({schemaVersion:1,adapters:[{scheme:"w",command:[process.execPath,script]}]}));
  const oldConfig = process.env.MESH_LEDGERS_FILE, oldLog = process.env.QUERY_FIXTURE_LOG;
  process.env.MESH_LEDGERS_FILE = config; process.env.QUERY_FIXTURE_LOG = log;
  t.after(() => {
    if(oldConfig === undefined) delete process.env.MESH_LEDGERS_FILE; else process.env.MESH_LEDGERS_FILE = oldConfig;
    if(oldLog === undefined) delete process.env.QUERY_FIXTURE_LOG; else process.env.QUERY_FIXTURE_LOG = oldLog;
  });
  const refs = Array.from({length:count},(_,i)=>`w:${i}`);
  const reader = new ShellPlexusLedgerReader({bridgeRoot:root,timeoutMs:120000,...(maxResultBytes === undefined ? {} : {maxResultBytes})});
  return {reader,root,log,refs,grant:{workspace_id:"workspace.test",ledger_refs:refs,session_ids:[]}};
}

test("oversized adapter responses split exact batches without retaining failed attempts", async t => {
  const h = await largeResponseFixture(t, 200);
  const result = await h.reader.read("items", {include_closed:true}, h.grant);
  assert.equal(result.total, 200);
  assert.deepEqual(new Set(result.items.map(i=>i.ref)), new Set(h.refs));
  assert.ok(result.items.every(i=>i.fields.long.length === 3900 && i.fields.other.length === 2100));
  const calls = (await readFile(h.log,"utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.map(c=>c.length), [200,100,100]);
  assert.deepEqual(calls.slice(1).flat(), h.refs);
});

test("default runner handles 10000 complete authorized rows beyond 16 MiB", async t => {
  const h = await largeResponseFixture(t, 10000);
  assert.equal(validLedgerReadGrants([h.grant],["workspace.test"]),true);
  const result = await h.reader.read("items", {include_closed:true}, h.grant);
  assert.equal(result.total,10000);
  assert.deepEqual(new Set(result.items.map(i=>i.ref)),new Set(h.refs));
  assert.ok(result.items.every(i=>i.fields.long.length===3900 && i.fields.other.length===2100));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) > 16*1024*1024);
});

test("complete-result byte budget fails atomically instead of truncating fields or refs", async t => {
  const h = await largeResponseFixture(t, 2, 10000);
  await assert.rejects(h.reader.read("items", {include_closed:true}, h.grant), /complete ledger result exceeds configured byte budget/);
  const calls = (await readFile(h.log,"utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls,[h.refs]);
  for(const maxResultBytes of [0,1023,256*1024*1024+1,Infinity]) {
    assert.throws(()=>new ShellPlexusLedgerReader({bridgeRoot,maxResultBytes}),/Invalid Plexus reader configuration/);
  }
});

for (const mode of ["singleton", "schema"]) {
  test(`response recovery does not retry ${mode === "singleton" ? "an oversized singleton" : "unrelated protocol errors"}`, async t => {
    const h = await largeResponseFixture(t, mode === "singleton" ? 1 : 200);
    await writeFile(join(h.root, "adapter.mjs"), `import {appendFileSync} from 'node:fs';let text='';for await(const part of process.stdin)text+=part;
const request=JSON.parse(text),op=process.argv.at(-1);
if(op==='capabilities')console.log(JSON.stringify({schema:'agent-mesh.ledger-adapter.v1',operations:['query']}));
else{appendFileSync(process.env.QUERY_FIXTURE_LOG,JSON.stringify(request.refs)+'\\n');
console.log(${mode === "singleton" ? "JSON.stringify({padding:'x'.repeat(1048576)})" : "JSON.stringify({schema:'wrong',items:[]})"});}`);
    await assert.rejects(h.reader.read("items", {}, h.grant), mode === "singleton" ? /adapter output exceeds size limit/ : /adapter returned invalid schema/);
    const calls = (await readFile(h.log, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls, [h.refs]);
  });
}

test("canonical query items reject invalid required metadata and numeric sort ranks", async () => {
  const mutations = [
    item => { delete item.title; },
    item => { delete item.updatedAt; },
    item => { item.status = "invented-state"; },
    item => { item.title = "two\nlines"; },
    item => { item.title = "x".repeat(513); },
    item => { item.title = "\ud800"; },
    item => { item.updatedAt = "2030-01-01T00:00:00"; },
    item => { item.updatedAt = "2030-02-30T00:00:00Z"; },
    item => { item.updatedAt = "not-a-time"; },
    item => { item.sortKeys = {priority:"first"}; },
    item => { item.sortKeys = {priority:true}; },
    item => { item.sortKeys = {priority:NaN}; },
    item => { item.sortKeys = {priority:null}; },
    item => { item.sortKeys = []; },
    item => { item.sortKeys = {"invalid key":1}; },
    item => { item.sortKeys = Object.fromEntries(Array.from({length:129},(_,i)=>[`field${i}`,i])); },
    item => { item.waitingOn = {who:"unknown"}; },
    item => { item.waitingOn = {who:"human",due:"2030-01-01"}; },
    item => { item.sessions = [{session:local,role:"unknown"}]; },
    item => { item.state = {invalid:true}; }
  ];
  for (const mutate of mutations) {
    const h = harness();
    mutate(h.items[0]);
    await assert.rejects(h.reader.read("items", {}, h.grant));
  }
  const h = harness();
  h.items[0] = {ref:refs[0],fields:{},sourceRevision:"sha256:"+"a".repeat(64),status:"invented-state"};
  await assert.rejects(h.reader.read("items", {}, h.grant));
});

test("canonical allowlist removes unknown envelope fields while preserving complete scalar fields", async () => {
  const h = harness();
  Object.assign(h.items[0], {extraEnvelope:"not part of protocol",waitingOn:{who:"human",ask:"Review",extra:"discard"},
    sessions:[{session:local,role:"owns",extra:"discard"}],updatedAt:"2030-01-01T01:00:00+01:00"});
  Object.assign(h.items[0].fields,{long:"x".repeat(6000),blank:"",unknown:null});
  const result = await h.reader.read("items", {include_closed:true}, h.grant);
  const row = result.items.find(i=>i.ref===refs[0]);
  assert.equal(row.fields.long.length,6000);
  assert.equal(row.fields.blank,"");
  assert.equal(row.fields.unknown,null);
  assert.equal(row.updatedAt,"2030-01-01T01:00:00+01:00");
  assert.ok(!Object.hasOwn(row,"extraEnvelope"));
  assert.deepEqual(row.waitingOn,{who:"human",ask:"Review"});
});

test("actual Fleet query fixture retains canonical aliases, raw fields, filters and sort", async () => {
  // Generated by the canonical adapter query on synthetic headers; refs are anonymized and local URLs omitted.
  const fixture = JSON.parse(await readFile(new URL("./fixtures/fleet-query-items.json", import.meta.url), "utf8"));
  const h = harness();
  h.items.splice(0,h.items.length,...fixture);
  h.grant.ledger_refs = fixture.map(item=>item.ref);
  for(const [field,expected] of Object.entries({priority:"urgent",size:"1_to_4h",project:"example",waiting_joseph:true})) {
    const selected = await h.reader.read("items",{filter:{[field]:expected}},h.grant);
    assert.equal(selected.total,1,field);
    assert.equal(selected.items[0].ref,"work:ITEM-1",field);
    assert.equal(selected.items[0][field],expected,field);
    for(const direction of ["asc","desc"]) {
      const sorted = await h.reader.read("items",{sort:[`${field}:${direction}`]},h.grant);
      const first = field === "size" ? "work:ITEM-2" : field === "waiting_joseph" ? "work:ITEM-2" : "work:ITEM-1";
      assert.equal(sorted.items[direction === "asc" ? 0 : 1].ref,first,`${field}:${direction}`);
    }
  }
  const all = await h.reader.read("items",{},h.grant);
  for(const original of fixture) {
    const row = all.items.find(i=>i.ref===original.ref);
    assert.deepEqual(row.fields,original.fields);
    assert.equal(row.fields.custom.length,3000);
    assert.ok(["priority","size","project","waiting_joseph"].every(key=>!Object.hasOwn(row.fields,key)));
  }
  for(const [key,value] of Object.entries({priority:1,size:false,project:{},waiting_joseph:"true"})) {
    const invalid = structuredClone(fixture);
    invalid[0][key] = value;
    h.items.splice(0,h.items.length,...invalid);
    await assert.rejects(h.reader.read("items",{},h.grant));
  }
});

test("scoped and service principals cannot discover or invoke owner-only ledger tools", async () => {
  for (const role of [undefined,false,true]) {
    for (const kind of ["user","service"]) {
      const h = harness(), handlers = new Map();
      h.principal.kind = kind;
      h.principal.plexusLedgerOwner = role;
      registerPlexusLedgerTools({registerTool(name,config,handler){handlers.set(name,{config,handler});}},h.options);
      assert.equal(handlers.size,kind === "user" && role === true ? 2 : 0);
      assert.equal(h.calls.length,0);
    }
  }
  const h = harness();
  h.principal.plexusLedgerOwner = false;
  for(const tool of ["mesh_plexus_work_items","mesh_plexus_ledger_sessions"]) {
    assert.equal((await h.invoke(tool,{ref:refs[0]})).isError,true);
    assert.equal(h.calls.length,0);
  }
  h.principal.plexusLedgerOwner = true;
  const result = await h.invoke("mesh_plexus_work_items",{limit:1});
  assert.equal(result.total,671);
  const count = h.calls.length;
  h.principal.plexusLedgerOwner = false;
  assert.equal((await h.invoke("mesh_plexus_work_items",{cursor:result.next_cursor})).isError,true);
  assert.equal(h.calls.length,count);
});

test("core still rejects a scoped caller before requesting ledger data", async () => {
  const {workItems} = await import(new URL("plexus.mjs",pathToFileURL(bridgeRoot+"/")).href);
  let reads = 0;
  assert.throws(()=>workItems({nodes:[],links:[]},{},{},()=>{reads++;return {items:[]};}),/local callers only/);
  assert.equal(reads,0);
});

test("owner designation is bound to verified identity, not scoped grants or binding claims", () => {
  for(const kind of ["user","service"]) {
    const h = harness(), selector = kind === "user" ? "owner@example.test" : "test-service";
    const binding = {...h.principal,kind,selector,plexusLedgerOwner:true,...(kind === "service" ? {plexusLedgerReadDelegate:true} : {})};
    const auth = {extra:{cloudflareAccessIdentity:{kind,subject:"test",selector}}};
    const scoped = resolveCloudflareAccessPrincipal(auth,[binding]);
    assert.equal(scoped.plexusLedgerOwner,undefined);
    assert.equal(resolveCloudflareAccessPrincipal(auth,[binding],scoped.id).plexusLedgerOwner,kind === "user");
    assert.equal(resolveCloudflareAccessPrincipal(auth,[binding],"different-principal").plexusLedgerOwner,false);
    assert.equal(resolveCloudflareAccessPrincipal(auth,[binding],undefined).plexusLedgerOwner,undefined);
  }
});


test("explicit service delegation reads exact grants without acquiring owner status", async () => {
  const h = harness({kind:"service", plexusLedgerOwner:false, plexusLedgerReadDelegate:true});
  assert.equal(h.handlers.size,2);
  assert.equal((await h.invoke("mesh_plexus_work_items",{limit:1})).total,671);
  assert.equal((await h.invoke("mesh_plexus_ledger_sessions",{ref:refs[0]})).sessions.length,2);
  const count=h.calls.length;
  for(const input of [{workspace_id:"other"},{ref:"work:OUTSIDE"}]) {
    assert.equal((await h.invoke(input.ref ? "mesh_plexus_ledger_sessions" : "mesh_plexus_work_items",input)).isError,true);
  }
  assert.equal(h.calls.length,count);
  h.principal.plexusLedgerReadDelegate=undefined;
  assert.equal((await h.invoke("mesh_plexus_work_items")).isError,true);
  assert.equal(h.calls.length,count);
});

test("service discovery requires delegation plus grants and each allowed tool", async () => {
  for(const overrides of [ {kind:"service"}, {kind:"service",plexusLedgerReadDelegate:true,ledgerReadGrants:[]},
    {kind:"service",plexusLedgerReadDelegate:true,ledgerReadGrants:undefined} ]) {
    assert.equal(harness(overrides).handlers.size,0);
  }
  const h=harness({kind:"service",plexusLedgerReadDelegate:true,allowedTools:["mesh_plexus_work_items"]});
  assert.deepEqual([...h.handlers.keys()],["mesh_plexus_work_items"]);
});

test("verified service binding propagates delegation independently of the user owner pin", async () => {
  const h=harness();
  const binding={...h.principal,kind:"service",selector:"test-service",plexusLedgerReadDelegate:true};
  const p=resolveCloudflareAccessPrincipal({extra:{cloudflareAccessIdentity:{kind:"service",subject:"test",selector:binding.selector}}},[binding],"other-owner");
  assert.equal(p.plexusLedgerReadDelegate,true);assert.equal(p.plexusLedgerOwner,false);
  const {registerMeshMcpTools}=await import("../src/mcp/mesh-mcp.ts");
  const registered=new Map();
  registerMeshMcpTools({registerTool(name,config,handler){registered.set(name,{config,handler});}},
    {...h.options,principal:{...p,allowedTools:[...p.allowedTools,"mesh_send"]},gateway:{},agents:[]});
  assert.deepEqual([...registered.keys()],["mesh_plexus_work_items","mesh_plexus_ledger_sessions"]);
  assert.ok([...registered.values()].every(t=>t.config.annotations.readOnlyHint===true));
});

test("runtime binding rejects user delegation, missing grants, non-booleans and non-read tools", async () => {
  const {validateBinding}=await import("../src/mcp/serve.ts");
  const h=harness(), valid={...h.principal,kind:"service",selector:"test-service",plexusLedgerReadDelegate:true};
  assert.doesNotThrow(()=>validateBinding(valid,0,[]));
  for(const change of [{kind:"user"},{ledgerReadGrants:undefined},{ledgerReadGrants:[]},
    {plexusLedgerReadDelegate:false},{plexusLedgerReadDelegate:"true"},{allowedTools:[]},
    {allowedTools:["mesh_send"]},{allowedTools:["mesh_plexus_work_items","mesh_submit"]}]) {
    assert.throws(()=>validateBinding({...valid,...change},0,[]),/Invalid MCP runtime binding/);
  }
});
