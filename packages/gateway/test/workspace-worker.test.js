import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { once } from "node:events";
import "./ts-extension-resolver.mjs";
const { WorkspaceWorkerRouter } = await import("../src/mcp/workspace-worker.ts");
const { sandboxArguments, canonicalDirectory } = await import("../src/mcp/workspace-sandbox.ts");
const { startIsolatedWorker } = await import("../src/mcp/workspace-worker-server.ts");
const { MeshTaskStore } = await import("../src/mcp/mesh-task-store.ts");
const { MeshTaskCoordinator } = await import("../src/mcp/mesh-task-coordinator.ts");
const { MeshMcpFacade, createMeshMcpHandler } = await import("../src/mcp/mesh-mcp.ts");
const { ShellAgentSessionProvider } = await import("../src/adapters/agent-session-provider.ts");
const sessionId = "11111111-1111-4111-8111-111111111111";
const nativeId = "22222222-2222-4222-8222-222222222222";
const route = { id: "worker.test", principalId: "owner", agentId: "agent.codex", workspaceId: "workspace.repo", accessMode: "workspace-write", socketPath: "/tmp/worker-test.sock" };
const task = (changes = {}) => ({ schema: "agent-mesh.mcp-task.v1", task_id: "mesh_task_test", context_id: "context.test", message_id: "message.test", principal_id: "owner", target_agent_id: "agent.codex", workspace_id: "workspace.repo", worker_id: "worker.test", access_mode: "workspace-write", session_id: sessionId, session_mode: "fresh", message: "Test", labels: [], idempotency_key: "test", ...changes });
async function fixture(t, accessMode = "workspace-write") {
  const base = await mkdtemp(join(tmpdir(), "mesh-worker-"));
  const config = { ...route, accessMode, provider: "codex", codeRoot: resolve(new URL("../../..", import.meta.url).pathname), repository: join(base, "repo"), home: join(base, "home"), temporary: join(base, "temp"), control: join(base, "control"), socketPath: join(base, "control", "worker.sock") };
  for (const p of [config.repository, config.home, config.temporary, config.control]) await mkdir(p, { mode: 0o700 });
  const git = spawnSync("git", ["-c", "init.templateDir=", "init", "--quiet", config.repository], { env: { PATH: process.env.PATH, HOME: config.home, GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, config };
}

test("write grants require exact principal, agent and repository and cannot escalate existing sessions", () => {
  const router = new WorkspaceWorkerRouter([route]);
  const input = { principalId: "owner", agentId: "agent.codex", workspaceId: "workspace.repo", accessMode: "workspace-write", sessionMode: "fresh" };
  assert.equal(router.authorize(input), route.id);
  for (const changes of [{ principalId: "intruder" }, { agentId: "agent.claude" }, { workspaceId: "workspace.other" }, { sessionMode: undefined, sessionId }, { sessionMode: "fresh", sessionId }]) assert.throws(() => router.authorize({ ...input, ...changes }), /denied/);
  assert.equal(router.authorize({ ...input, accessMode: "read-only" }), undefined);
  assert.throws(() => new WorkspaceWorkerRouter([{ ...route, principalId: "*" }]), /Invalid/);
  assert.throws(() => new WorkspaceWorkerRouter([route, route]), /Duplicate/);
});

test("canonical mount paths reject traversal, symlink roots and overlapping mounts", async (t) => {
  const { config, base } = await fixture(t);
  await symlink(config.repository, join(base, "alias"));
  assert.throws(() => canonicalDirectory(join(base, "alias")), /canonical/);
  assert.throws(() => canonicalDirectory(`${config.repository}/../repo`), /canonical/);
  assert.throws(() => sandboxArguments({ ...config, home: config.repository }, "/bin/true", []), /overlap/);
});

for (const mode of ["read-only", "workspace-write"]) test(`OS sandbox ${mode}: repository mutations, outside writes, symlink escape and secret isolation`, async (t) => {
  const { config, base } = await fixture(t, mode);
  const outside = join(base, "outside"); await mkdir(outside); await writeFile(join(outside, "sentinel"), "unchanged");
  await symlink(outside, join(config.repository, "escape"));
  const script = `const fs=require('node:fs'); const root=${JSON.stringify(config.repository)}; let writable=false;
    try {fs.writeFileSync(root+'/probe','a'); fs.writeFileSync(root+'/probe','b'); if(fs.readFileSync(root+'/probe','utf8')!=='b')throw Error(); fs.unlinkSync(root+'/probe'); writable=true;} catch(e) {if(!['EROFS','EACCES'].includes(e.code))throw e;}
    if(writable!==${mode === "workspace-write"})throw Error('wrong write mode');
    for(const p of [${JSON.stringify(outside + "/sentinel")}, root+'/escape/sentinel', '/usr/mesh-probe']) {try{fs.writeFileSync(p,'escaped'); throw Error('escape');}catch(e){if(e.message==='escape')throw e;}}
    if(process.env.MESH_TEST_SECRET)throw Error('host environment leaked');
    if(fs.existsSync(${JSON.stringify(join(homedir(), '.codex'))}))throw Error('host home exposed');`;
  const result = spawnSync("/usr/bin/bwrap", sandboxArguments(config, process.execPath, ["-e", script]), { env: { MESH_TEST_SECRET: "test" }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "unchanged");
});

test("worker RPC is correlated, idempotent, principal scoped and restart safe", async (t) => {
  const { config } = await fixture(t); let sends = 0;
  const provider = { send: async () => { sends++; return { ok: true, reply: "changed and tested", session_id: nativeId }; } };
  let server = await startIsolatedWorker(config, provider);
  const close = async () => { await new Promise((ok) => server.close(ok)); await rm(config.socketPath, { force: true }); };
  t.after(close);
  const router = new WorkspaceWorkerRouter([config]); let bound;
  const request = task();
  assert.equal((await router.execute(request, { bindSession: async (id) => { bound = id; } })).text, "changed and tested");
  assert.equal(bound, nativeId);
  await router.execute({ ...request, updated_at: "2026-10-19T00:00:00Z" }, { bindSession: async () => {} }); assert.equal(sends, 1);
  await assert.rejects(router.execute(task({ principal_id: "intruder" }), { bindSession: async () => {} }), /denied/);
  await close(); server = await startIsolatedWorker(config, provider);
  await router.execute({ ...request, updated_at: "2026-10-19T00:00:00Z" }, { bindSession: async () => {} }); assert.equal(sends, 1);
  await router.execute(task({ task_id: "followup", session_mode: undefined, session_id: nativeId }), { bindSession: async () => {} }); assert.equal(sends, 2);
  const journal = await readFile(join(config.control, "worker-events.ndjson"), "utf8");
  assert.match(journal, /"principalId":"owner"/); assert.match(journal, /"accessMode":"workspace-write"/); assert.doesNotMatch(journal, /"message":"Test"/);
});

test("missing worker fails explicitly without invoking a legacy executor", async () => {
  const router = new WorkspaceWorkerRouter([{ ...route, socketPath: "/nonexistent/worker.sock" }]);
  await assert.rejects(router.execute(task(), { bindSession: async () => {} }), /workspace_worker_unavailable/);
});

async function facadeFixture(t) {
  const { config } = await fixture(t);
  const router = new WorkspaceWorkerRouter([config]);
  const store = new MeshTaskStore({ stateDir: config.control });
  const coordinator = new MeshTaskCoordinator({ store, execute: async (task, hooks) => { await hooks.bindSession(nativeId); return { text: "ok" }; } });
  const options = { gateway: {}, principal: { id: "owner", kind: "user", requesterId: "requester", allowedTools: ["mesh_call", "mesh_submit"], allowedAgentIds: ["agent.codex"], allowedWorkspaceIds: ["workspace.repo"], allowedDomainIds: ["domain.test"] }, agents: [{ id: "agent.codex", name: "Codex", provider: "codex" }], rateLimiter: { consume: () => true }, taskCoordinator: coordinator, workspaceWorkers: router };
  return { facade: new MeshMcpFacade(options), options, store };
}
test("MCP task keeps immutable access and native session provenance on resume and replay", async (t) => {
  const { facade } = await facadeFixture(t);
  const input = { targetAgentId: "agent.codex", sessionMode: "fresh", accessMode: "workspace-write", message: "change", idempotencyKey: "first" };
  const first = await facade.callTask(input, 1000);
  assert.equal(first.task.session_id, nativeId); assert.equal(first.task.session_provenance.session_id, nativeId);
  assert.equal(first.task.access_mode, "workspace-write"); assert.equal(first.task.worker_id, route.id);
  const replay = await facade.callTask(input, 1000); assert.equal(replay.task.session_id, nativeId); assert.equal(replay.duplicate, true);
  const resumed = await facade.callTask({ targetAgentId: "agent.codex", sessionId: nativeId, message: "test", idempotencyKey: "next" }, 1000);
  assert.equal(resumed.task.access_mode, "workspace-write");
  await assert.rejects(facade.submitTask({ targetAgentId: "agent.codex", sessionId: nativeId, accessMode: "read-only", message: "x", idempotencyKey: "bad" }), /immutable/);
  await assert.rejects(facade.submitTask({ ...input, idempotencyKey: "first", accessMode: "read-only" }), /unsupported|conflicts/);
});

test("published MCP schemas expose access_mode on both task tools", async (t) => {
  const { options } = await facadeFixture(t);
  const handler = createMeshMcpHandler({ ...options, resolvePrincipal: () => options.principal });
  const response = await handler.fetch(new Request("https://example.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "worker-test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } }) }), { authInfo: { token: "t", clientId: "fixture", scopes: [] } });
  const body = await response.text();
  const tools = JSON.parse(body).result.tools.filter((tool) => ["mesh_call", "mesh_submit"].includes(tool.name));
  assert.equal(tools.length, 2);
  for (const tool of tools) {
    assert.deepEqual(tool.inputSchema.properties.access_mode.enum, ["read-only", "workspace-write"]);
    assert.equal(tool.inputSchema.properties.workspace_path.type, "string");
    assert.ok(!tool.inputSchema.required.includes("access_mode"));
    assert.ok(!tool.inputSchema.required.includes("workspace_path"));
  }
});

for (const agentType of ["claude", "codex"]) for (const mode of ["read-only", "workspace-write"]) test(`${agentType} ${mode} fresh and resumed worker adapter uses scoped provider permissions and returns native IDs`, async () => {
  const calls = [];
  let noWriter = false;
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const provider = new ShellAgentSessionProvider({ agentId: `agent.${agentType}`, agentType, agentSessionPath: "/bridge/session", agentSendPath: "/bridge/send", workspaceRoots: { "workspace.repo": ["/srv/repo"] }, freshSessionCwds: { "workspace.repo": "/srv/repo" }, freshTaskSessions: agentType === "codex", isolatedAccessMode: mode, run: async (cmd, args) => {
    calls.push(args);
    if (cmd === "/bridge/send") return ok("done");
    const sub = args[2];
    if (sub === "new") return ok(`${args[4]}\n`);
    if (sub === "target-session") return ok(nativeId);
    if (sub === "resume") return ok(`mesh-${agentType}-resumed`);
    if (sub === "writer-status" && noWriter) { noWriter = false; return ok(JSON.stringify({ agent: agentType, sessionId: args[3], writers: [], discovery: { complete: true } })); }
    if (sub === "writer-status") return ok(JSON.stringify({ agent: agentType, sessionId: agentType === "codex" ? nativeId : sessionId, discovery: { complete: true }, writers: [{ pid: 12, kind: agentType === "codex" ? "codex" : "claude-cli" }] }));
    if (sub === "target-status") return ok(JSON.stringify({ target: args[3], pane_pid: 11, writer_pid: 12 }));
    if (sub === "inspect") return ok(JSON.stringify({ agent_type: agentType, sessions: [{ session_id: args[3], agent_type: agentType, cwd: "/srv/repo", updated_at: "2026-10-19T00:00:00Z" }] }));
    throw Error(`Unexpected command ${sub}`);
  } });
  const result = await provider.send({ sessionId, workspaceId: "workspace.repo", sessionMode: "fresh", message: "change", messageId: "m", contextId: "c", correlationId: "t", idempotencyKey: "k" });
  assert.equal(result.ok, true, result.error);
  const launch = calls.find((args) => args[2] === "new");
  if (agentType === "codex") { assert.equal(result.session_id, nativeId); assert.deepEqual(launch.slice(-4), ["--sandbox", mode, "--ask-for-approval", "never"]); }
  else {
    assert.equal(launch[launch.indexOf("--permission-mode") + 1], mode === "workspace-write" ? "acceptEdits" : "default");
    assert.ok(launch.includes("Bash"));
    assert.equal(launch.includes("Write"), mode === "workspace-write");
    assert.equal(launch.includes("Edit"), mode === "workspace-write");
  }
  assert.ok(!launch.includes("danger-full-access"));
  noWriter = true;
  const resumed = await provider.send({ sessionId: agentType === "codex" ? nativeId : sessionId, workspaceId: "workspace.repo", message: "test", messageId: "m2", contextId: "c", correlationId: "t2", idempotencyKey: "k2" });
  assert.equal(resumed.ok, true, resumed.error);
  assert.ok(calls.some((args) => args[2] === "resume" && args[3] === (agentType === "codex" ? nativeId : sessionId)));
});

test("production worker launcher starts only in the pinned mount namespace and leaves gateway paths hidden", async (t) => {
  const { config, base } = await fixture(t);
  const auth = join(base, "provider-fixture.json");
  await writeFile(auth, JSON.stringify({ claudeAiOauth: { accessToken: "demo" }, mcpOAuth: { unrelated: "exclude" } }), { mode: 0o600 });
  config.readOnlyFiles = [{ source: auth, target: ".claude/.credentials.json", jsonKeys: ["claudeAiOauth"] }];
  const file = join(base, "worker.json"); await writeFile(file, JSON.stringify(config));
  const child = spawn(process.execPath, [join(config.codeRoot, "packages/gateway/dist/mcp/workspace-worker-server.js"), file], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = once(child, "exit");
  t.after(async () => { if (child.exitCode === null) child.kill("SIGTERM"); await exited; });
  const router = new WorkspaceWorkerRouter([config]);
  let started = false;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) break;
    try { await router.execute(task({ session_mode: undefined }), { bindSession: async () => {} }); }
    catch (error) { if (error.message.includes("Session is not owned")) { started = true; break; } }
    await new Promise((ok) => setTimeout(ok, 50));
  }
  assert.equal(started, true, stderr);
});

test("an existing read-only session cannot be upgraded and revoked workers never fall back", async (t) => {
  const { facade, store, options } = await facadeFixture(t);
  await store.create({ principalId: "owner", principalKind: "user", requesterId: "requester", targetAgentId: "agent.codex", sessionId,
    workspaceId: "workspace.repo", domainId: "domain.test", message: "read", labels: [], idempotencyKey: "old" });
  await assert.rejects(facade.submitTask({ targetAgentId: "agent.codex", sessionId, accessMode: "workspace-write", message: "upgrade", idempotencyKey: "upgrade" }), /immutable/);
  const request = { targetAgentId: "agent.codex", sessionMode: "fresh", accessMode: "workspace-write", message: "change", idempotencyKey: "write" };
  const { task } = await facade.callTask(request, 1000);
  const revoked = new MeshMcpFacade({ ...options, workspaceWorkers: new WorkspaceWorkerRouter([]) });
  await assert.rejects(revoked.submitTask({ targetAgentId: "agent.codex", sessionId: task.session_id, message: "resume", idempotencyKey: "revoked" }), /revoked/);
  const removed = new MeshMcpFacade({ ...options, workspaceWorkers: undefined });
  await assert.rejects(removed.submitTask({ targetAgentId: "agent.codex", sessionId: task.session_id, message: "resume", idempotencyKey: "missing" }), /workspace_worker_unavailable/);
});

test("legacy Codex native session ID binds before a transport failure is reported", async () => {
  const { executeMeshTask } = await import("../src/mcp/mesh-mcp.ts");
  const { AgentSessionTransportAdapter } = await import("../src/adapters/agent-session-transport-adapter.ts");
  const { AgentSessionRegistry } = await import("../src/adapters/agent-session-provider.ts");
  const registry = new AgentSessionRegistry([{ agentId: "agent.codex", send: async () => ({ ok: false, error: "send failed", session_id: nativeId }) }]);
  const adapter = new AgentSessionTransportAdapter(registry);
  let delivery; let bound;
  const request = task();
  const gateway = {
    submitEnvelope: async (envelope) => { delivery = await adapter.dispatch({ target_agent_id: "agent.codex" }, envelope); return { deliveries: [{ adapter_id: adapter.id, status: delivery.status }] }; },
    listAudit: async () => [{ details: { adapter_id: adapter.id, adapter_details: delivery.details } }]
  };
  await assert.rejects(executeMeshTask(gateway, request, undefined, { bindSession: async (id) => { bound = id; } }), /did not deliver/);
  assert.equal(bound, nativeId);
  assert.equal(delivery.details.correlation_id, request.task_id);
});

for (const failure of [undefined, "ambiguous", "foreign pane", "wrong cwd", "timeout"]) test(`isolated Codex first turn without DB/JSONL: ${failure ?? "owned native success"}`, async () => {
  const calls = [];
  const provider = new ShellAgentSessionProvider({ agentId: "agent.codex", agentType: "codex", agentSessionPath: "/bridge/session", agentSendPath: "/bridge/send", workspaceRoots: { "workspace.repo": ["/srv/repo"] }, freshSessionCwds: { "workspace.repo": "/srv/repo" }, freshTaskSessions: true, isolatedAccessMode: "workspace-write", run: async (cmd, args) => {
    calls.push({ cmd, args });
    const ok = stdout => ({ code: 0, stdout, stderr: "" });
    if (cmd === "/bridge/send") return ok("correlated reply");
    if (args[2] === "new") return ok(args[4]);
    if (args[2] === "target-session") {
      assert.deepEqual(args.slice(4), ["--owned-cwd", "/srv/repo"]);
      return failure ? { code: failure === "timeout" ? 124 : 4, stdout: "", stderr: "owned proof unavailable" } : ok(nativeId);
    }
    if (args[2] === "writer-status") return ok(JSON.stringify({ agent: "codex", sessionId: nativeId, writers: [{ pid: 12, kind: "codex" }] }));
    if (args[2] === "target-status") return ok(JSON.stringify({ target: args[3], pane_pid: 11, writer_pid: 12 }));
    if (args[2] === "kill") return ok("");
    if (args[2] === "inspect") return { code: 3, stdout: "", stderr: "no persisted JSONL" };
    throw new Error("Unexpected bridge command");
  } });
  const result = await provider.send({ sessionId, workspaceId: "workspace.repo", sessionMode: "fresh", message: "first turn", messageId: "m", contextId: "c", correlationId: "task", idempotencyKey: "k" });
  assert.equal(calls.some(c => c.args[2] === "inspect"), false);
  if (failure) { assert.equal(result.error_code, "fresh_session_create_failed"); assert.equal(calls.filter(c => c.cmd === "/bridge/send").length, 0); assert.equal(calls.filter(c => c.args[2] === "kill").length, 1); }
  else { assert.equal(result.ok, true); assert.equal(result.session_id, nativeId); assert.notEqual(result.session_id, sessionId); assert.equal(calls.filter(c => c.cmd === "/bridge/send").length, 1); }
});

test("private provider diagnostics contain bounded command metadata without raw output", async () => {
 const diagnostics=[];
 const provider=new ShellAgentSessionProvider({agentId:"agent.codex",agentType:"codex",agentSessionPath:"/bridge/session",agentSendPath:"/bridge/send",workspaceRoots:{"workspace.repo":["/srv/repo"]},freshSessionCwds:{"workspace.repo":"/srv/repo"},freshTaskSessions:true,isolatedAccessMode:"read-only",onDiagnostic:event=>diagnostics.push(event),run:async(_command,args)=>args[2]==="new"?{code:0,stdout:args[4],stderr:""}:args[2]==="kill"?{code:0,stdout:"",stderr:""}:{code:4,stdout:"fixture stdout must not persist",stderr:"fixture detail must not persist [stage=inventory.exe,code=ENOENT]"}});
 const output=await provider.send({sessionId,workspaceId:"workspace.repo",sessionMode:"fresh",message:"fixture",messageId:"m",contextId:"c",correlationId:"t",idempotencyKey:"k"});
 assert.equal(output.error_code,"fresh_session_create_failed");
 assert.deepEqual(diagnostics,[{stage:"target-session",exitCode:4,proofStage:"inventory.exe",proofCode:"ENOENT"}]);
 assert.doesNotMatch(JSON.stringify(diagnostics),/fixture stdout|fixture detail/);
});
