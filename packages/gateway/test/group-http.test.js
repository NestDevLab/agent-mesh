import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import "./ts-extension-resolver.mjs";

if (globalThis.crypto === undefined) globalThis.crypto = webcrypto;
const { startMeshMcpServer } = await import("../src/mcp/serve.ts");
const issuer = "https://identity.example.test";
const actor = "codex:11111111-1111-4111-8111-111111111111";
const workspace = "workspace.example";

async function freePort() {
  const server = createServer();
  await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const port = server.address().port;
  await new Promise(resolveClose => server.close(resolveClose));
  return port;
}

test("isolated HTTP gateway verifies signed principals and routes group leases", async t => {
  const root = await mkdtemp(join(tmpdir(), "mesh-http-groups-"));
  const state = join(root, "groups"), gatewayState = join(root, "gateway"), socket = join(root, "broker.sock");
  const bin = resolve("../tmux-bridge/bin");
  const oldState = process.env.XDG_STATE_HOME, oldFetch = globalThis.fetch;
  const env = { ...process.env, XDG_STATE_HOME: root, MESH_GROUPS_STATE: state, PYTHONDONTWRITEBYTECODE: "1" };
  let broker, closeGateway;
  t.after(async () => {
    globalThis.fetch = oldFetch;
    if (oldState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = oldState;
    if (closeGateway) await closeGateway();
    if (broker && broker.exitCode === null && broker.signalCode === null) {
      await new Promise(resolveExit => { broker.once("exit", resolveExit); broker.kill("SIGTERM"); });
    }
    await rm(root, { recursive: true, force: true });
  });
  process.env.XDG_STATE_HOME = root;
  await mkdir(gatewayState);
  const cli = (...args) => JSON.parse(execFileSync("python3", [join(bin, "mesh-groups.py"), ...args], { env, encoding: "utf8" }));
  const group = cli("create", "Example").group_id;
  cli("add", group, actor);
  cli("link", group, "work:item-1");
  broker = spawn("python3", [join(bin, "mesh_group_broker.py"), "--socket", socket, "--state", state], { env, stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try { if ((await stat(socket)).isSocket()) break; } catch { /* starting */ }
    if (broker.exitCode !== null) throw new Error("test broker exited");
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256", use: "sig" };
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/agent-mesh`;
  globalThis.fetch = async (input, init) => {
    const address = input instanceof Request ? input.url : String(input);
    if (address === issuer + "/cdn-cgi/access/certs") return new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200, headers: { "content-type": "application/json" }
    });
    throw new Error("Unexpected outbound request: " + address);
  };
  const memberTools = ["mesh_group_list", "mesh_group_lock_inspect", "mesh_group_lock_acquire", "mesh_group_lock_release"];
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ stateDir: gatewayState, agents: [], contexts: [],
    groups: { socketPath: socket }, bindings: [
      { kind: "service", selector: "member", allowedTools: memberTools, allowedAgentIds: [],
        allowedWorkspaceIds: [workspace], allowedDomainIds: [], groupGrants: [{
          workspace_id: workspace, session_id: actor, group_ids: [group], ledger_refs: ["work:item-1"]
        }] },
      { kind: "service", selector: "admin", allowedTools: ["mesh_group_create"], allowedAgentIds: [],
        allowedWorkspaceIds: [], allowedDomainIds: [], manageAllGroups: true }
    ] }), { mode: 0o600 });
  closeGateway = await startMeshMcpServer({ AGENT_MESH_MCP_HOST: "127.0.0.1",
    AGENT_MESH_MCP_PORT: String(port), AGENT_MESH_MCP_CONFIG: config,
    AGENT_MESH_MCP_TEAM_DOMAIN: issuer, AGENT_MESH_MCP_AUDIENCE: "mesh-test" });
  const sign = (key, common_name) => new SignJWT({ common_name })
    .setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer(issuer).setAudience("mesh-test")
    .setSubject("synthetic").setIssuedAt().setExpirationTime("5m").sign(key);
  const member = await sign(privateKey, "member"), admin = await sign(privateKey, "admin");
  const unknown = await sign(privateKey, "unknown");
  const wrongKey = await generateKeyPair("RS256");
  const forged = await sign(wrongKey.privateKey, "admin");
  async function call(token, name, args) {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name };
    if (token) headers["cf-access-jwt-assertion"] = token;
    const response = await oldFetch(url, { method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name, arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {} }
      } }) });
    const body = await response.json();
    return { status: response.status, result: body.result ?? body.error ?? body };
  }
  assert.equal((await call(null, "mesh_group_list", {})).status, 401);
  assert.equal((await call(forged, "mesh_group_create", { name: "Bad", request_id: "bad" })).status, 401);
  assert.equal((await call(unknown, "mesh_group_list", {})).status, 403);
  const listed = await call(member, "mesh_group_list", { workspace_id: workspace });
  assert.equal(listed.status, 200);
  assert.equal(listed.result.structuredContent.groups[0].group_id, group);
  const denied = await call(member, "mesh_group_create", { name: "Denied", request_id: "denied" });
  assert.ok(denied.status === 404 || denied.result?.isError === true || typeof denied.result?.code === "number",
    JSON.stringify(denied));
  const created = await call(admin, "mesh_group_create", { name: "Created", request_id: "create-one" });
  assert.equal(created.result.structuredContent.created, true);
  const duplicate = await call(admin, "mesh_group_create", { name: "Created", request_id: "create-one" });
  assert.equal(duplicate.result.structuredContent.created, false);
  assert.equal(duplicate.result.structuredContent.group.group_id, created.result.structuredContent.group.group_id);
  const lockArgs = { workspace_id: workspace, group_id: group, ref: "work:item-1" };
  const acquired = await call(member, "mesh_group_lock_acquire", { ...lockArgs, fence: 0, ttl: 60 });
  assert.equal(acquired.result.structuredContent.outcome, "acquired");
  const inspected = await call(member, "mesh_group_lock_inspect", lockArgs);
  assert.equal(inspected.result.structuredContent.status, "active");
  assert.equal(inspected.result.structuredContent.leaseId, undefined);
  const released = await call(member, "mesh_group_lock_release", { ...lockArgs,
    fence: acquired.result.structuredContent.fence, lease_id: acquired.result.structuredContent.leaseId });
  assert.equal(released.result.structuredContent.outcome, "released");
  await closeGateway();
  closeGateway = undefined;
  await new Promise(resolveExit => { broker.once("exit", resolveExit); broker.kill("SIGTERM"); });
  assert.equal(broker.exitCode, 0);
  await assert.rejects(oldFetch(url), /fetch failed/);
  await assert.rejects(stat(socket), { code: "ENOENT" });
});
