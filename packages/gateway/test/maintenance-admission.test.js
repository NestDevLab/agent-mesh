import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat, symlink, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { createServer } from "node:http";
import test from "node:test";
import "./ts-extension-resolver.mjs";
const { MaintenanceAdmission, ADMISSION_PROTOCOL } = await import("../src/mcp/maintenance-admission.ts");
const { MeshTaskCoordinator } = await import("../src/mcp/mesh-task-coordinator.ts");
const { MeshTaskStore } = await import("../src/mcp/mesh-task-store.ts");

async function command(control, operation, owner) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(control.socketPath);
    socket.on("error", reject);
    socket.on("connect", () => socket.write(JSON.stringify({ operation, owner }) + "\n"));
    let buffer = "";
    socket.on("data", chunk => { buffer += chunk; if (buffer.includes("\n")) { socket.end(); resolve(JSON.parse(buffer.split("\n")[0])); } });
  });
}
async function setup(t, count = async () => 0) {
  const dir = await mkdtemp(join(tmpdir(), "mesh-admission-"));
  const control = new MaintenanceAdmission(dir, count);
  await control.start();
  t.after(() => control.close());
  return { dir, control, owner: randomUUID() };
}

test("pause closes all HTTP profiles while admitted requests finish and remain counted", async t => {
  const { control, owner } = await setup(t);
  let finish, entered;
  const started = new Promise(r => entered = r);
  const pending = new Promise(r => finish = r);
  let executions = 0;
  const server = createServer((req, res) => control.handle(req, res, async () => {
    executions++; entered(); await pending; res.end("finished");
  }));
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise(r => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const running = fetch(url + "/agent-mesh", { method: "POST", body: "task" });
  await started;
  const paused = await command(control, "pause", owner);
  assert.equal(paused.paused, true);
  assert.equal(paused.inflightRequests, 1);
  assert.equal(paused.pid, process.pid);
  for (const path of ["/agent-mesh", "/mail", "/drive", "/memory", "/unknown"]) {
    assert.equal((await fetch(url + path, { method: "POST", body: "mesh_send or mesh_submit" })).status, 503);
  }
  assert.equal(executions, 1);
  finish(); assert.equal(await (await running).text(), "finished");
  assert.equal((await command(control, "status", owner)).inflightRequests, 0);
  assert.equal((await command(control, "resume", randomUUID())).ok, false);
  assert.equal((await command(control, "status", owner)).paused, true);
  assert.equal((await command(control, "resume", owner)).paused, false);
});

test("pause marker survives replacement control and only its owner can resume", async t => {
  const { dir, control, owner } = await setup(t);
  await command(control, "pause", owner);
  assert.equal((await stat(control.socketPath)).mode & 0o777, 0o600);
  const path = join(dir, "maintenance-admission.json");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { protocol: ADMISSION_PROTOCOL, owner });
  await control.close();
  const replacement = new MaintenanceAdmission(dir, async () => 0);
  await replacement.start(); t.after(() => replacement.close());
  assert.equal((await command(replacement, "status", randomUUID())).owner, owner);
  assert.equal((await command(replacement, "status", owner)).paused, true);
  assert.equal((await command(replacement, "pause", randomUUID())).ok, false);
  assert.equal((await command(replacement, "resume", owner)).paused, false);
  await assert.rejects(readFile(path), { code: "ENOENT" });
});

test("malformed, unsafe-permission, and symlink markers fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mesh-marker-"));
  const path = join(dir, "maintenance-admission.json");
  await writeFile(path, "garbage", { mode: 0o600 });
  assert.throws(() => new MaintenanceAdmission(dir, async () => 0));
  await unlink(path);
  await writeFile(path, JSON.stringify({ protocol: ADMISSION_PROTOCOL, owner: randomUUID() }), { mode: 0o644 });
  assert.throws(() => new MaintenanceAdmission(dir, async () => 0), /Unsafe/);
  await unlink(path); await symlink(join(dir, "missing"), path);
  assert.throws(() => new MaintenanceAdmission(dir, async () => 0), /Unsafe/);
});

test("live and unsafe socket paths cannot be stolen", async t => {
  const { dir, control, owner } = await setup(t);
  const other = new MaintenanceAdmission(dir, async () => 0);
  await assert.rejects(other.start(), /already live/);
  assert.equal((await command(control, "status", owner)).ok, true);
  await control.close();
  await writeFile(control.socketPath, "unrelated");
  await assert.rejects(other.start(), /Unsafe/);
  assert.equal(await readFile(control.socketPath, "utf8"), "unrelated");
});

test("serialized pause/resume commands retain a single owner", async t => {
  const { control, owner } = await setup(t);
  const other = randomUUID();
  const results = await Promise.all([command(control, "pause", owner), command(control, "pause", other)]);
  assert.equal(results.filter(r => r.ok).length, 1);
  const status = await command(control, "status", owner);
  assert.equal(status.paused, true);
  assert.equal((await command(control, "resume", status.owner)).paused, false);
});

test("cancelled executing task still prevents drain until executor returns", async t => {
  const dir = await mkdtemp(join(tmpdir(), "mesh-task-drain-"));
  let finish, began;
  const started = new Promise(r => began = r);
  const pending = new Promise(r => finish = r);
  const store = new MeshTaskStore({ stateDir: dir });
  const coordinator = new MeshTaskCoordinator({ store, execute: async () => { began(); await pending; return { text: "ok" }; } });
  const { control, owner } = await setup(t, () => coordinator.nonterminalTaskCount());
  const { task } = await coordinator.submit({ principalId: "p", principalKind: "service", requesterId: "r", targetAgentId: "a", workspaceId: "w", domainId: "d", message: "work", labels: [], idempotencyKey: "k" });
  await started;
  await coordinator.cancel(task.task_id, "p");
  assert.equal((await store.get(task.task_id)).status, "cancelled");
  assert.equal((await command(control, "pause", owner)).nonterminalTasks, 1);
  finish();
  for (let i = 0; i < 100 && await coordinator.nonterminalTaskCount(); i++) await new Promise(r => setTimeout(r, 5));
  assert.equal((await command(control, "status", owner)).nonterminalTasks, 0);
  // Store state remains a separate drain source even when there is no active executor.
  await store.create({ principalId: "p", principalKind: "service", requesterId: "r", targetAgentId: "a", workspaceId: "w", domainId: "d", message: "unresumed", labels: [], idempotencyKey: "k2" });
  assert.equal((await command(control, "status", owner)).nonterminalTasks, 1);
});

test("real MCP server gates mesh_send and task submission through every configured profile", async t => {
  const { startMeshMcpServer } = await import("../src/mcp/serve.ts");
  const dir = await mkdtemp(join(tmpdir(), "mesh-http-gate-"));
  const owner = randomUUID();
  // Persist before startup to also exercise the actual server restart path.
  await writeFile(join(dir, "maintenance-admission.json"), JSON.stringify({ protocol: ADMISSION_PROTOCOL, owner }), { mode: 0o600 });
  const config = join(dir, "config.json");
  await writeFile(config, JSON.stringify({ stateDir: dir, agents: [], contexts: [], bindings: [{ kind: "service", selector: "test-client", allowedTools: ["mesh_send", "mesh_submit"], allowedAgentIds: [], allowedWorkspaceIds: [], allowedDomainIds: [] }], googleWorkspace: { accounts: { work: { account: "work@example.test" }, personal: { account: "personal@example.test" } } } }));
  const probe = createServer();
  await new Promise(r => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  const close = await startMeshMcpServer({ AGENT_MESH_MCP_HOST: "127.0.0.1", AGENT_MESH_MCP_PORT: String(port), AGENT_MESH_MCP_CONFIG: config, AGENT_MESH_MCP_TEAM_DOMAIN: "https://example.cloudflareaccess.com", AGENT_MESH_MCP_AUDIENCE: "test", AGENT_MESH_MCP_WORKSPACE_AUDIENCE: "workspace", AGENT_MESH_MCP_GOOGLE_WORKSPACE_AUDIENCE: "google", AGENT_MESH_MCP_MEMORY_AUDIENCE: "memory" });
  t.after(close);
  const control = { socketPath: join(dir, "maintenance-admission.sock") };
  assert.equal((await command(control, "status", owner)).owner, owner);
  for (const path of ["/agent-mesh", "/workspace", "/google-workspace", "/memory"]) {
    for (const name of ["mesh_send", "mesh_submit"]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }) });
      assert.equal(response.status, 503, path + " " + name);
    }
  }
  await command(control, "resume", owner);
  assert.equal((await fetch(`http://127.0.0.1:${port}/agent-mesh`)).status, 401);
});


test("stale refused Unix socket is recovered without weakening persisted pause", async t => {
  const dir = await mkdtemp(join(tmpdir(), "mesh-stale-"));
  const socketPath = join(dir, "maintenance-admission.sock");
  execFileSync(process.execPath, ["--input-type=module", "-e", 'import {createServer} from "node:net"; createServer().listen(process.argv[1], () => process.exit(0));', socketPath]);
  const owner = randomUUID();
  await writeFile(join(dir, "maintenance-admission.json"), JSON.stringify({ protocol: ADMISSION_PROTOCOL, owner }), { mode: 0o600 });
  const control = new MaintenanceAdmission(dir, async () => 0);
  await control.start(); t.after(() => control.close());
  assert.equal((await command(control, "status", owner)).paused, true);
});


test("request drain waits for both response completion and execution even after disconnect", async t => {
  const { control, owner } = await setup(t);
  const response = new EventEmitter();
  control.handle({}, response, async () => {});
  await new Promise(r => setImmediate(r));
  assert.equal((await command(control, "pause", owner)).inflightRequests, 1);
  response.emit("finish");
  assert.equal((await command(control, "status", owner)).inflightRequests, 0);
  await command(control, "resume", owner);
  let finish;
  const pending = new Promise(r => finish = r);
  const disconnected = new EventEmitter();
  control.handle({}, disconnected, () => pending);
  disconnected.emit("close");
  assert.equal((await command(control, "pause", owner)).inflightRequests, 1);
  finish(); await new Promise(r => setImmediate(r));
  assert.equal((await command(control, "status", owner)).inflightRequests, 0);
});

test("failed drain statistics cannot release a paused lease", async t => {
  let fail = false;
  const { control, owner, dir } = await setup(t, async () => { if (fail) throw new Error("store unavailable"); return 0; });
  await command(control, "pause", owner);
  fail = true;
  assert.equal((await command(control, "resume", owner)).ok, false);
  assert.equal(JSON.parse(await readFile(join(dir, "maintenance-admission.json"), "utf8")).owner, owner);
  fail = false;
  assert.equal((await command(control, "status", owner)).paused, true);
});


test("rejected HTTP response remains counted until its delayed finish", async t => {
  const { control, owner } = await setup(t);
  await command(control, "pause", owner);
  const response = new EventEmitter();
  let status;
  response.writeHead = code => { status = code; };
  response.end = () => {};
  let executed = false;
  control.handle({}, response, async () => { executed = true; });
  assert.equal(status, 503);
  assert.equal(executed, false);
  assert.equal((await command(control, "status", owner)).inflightRequests, 1);
  response.emit("finish");
  assert.equal((await command(control, "status", owner)).inflightRequests, 0);
});
