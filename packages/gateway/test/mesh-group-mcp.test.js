import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import "./ts-extension-resolver.mjs";

const { createMeshMcpHandler, FixedWindowMeshMcpRateLimiter } = await import("../src/mcp/mesh-mcp.ts");
const { UnixGroupGateway, validGroupGrants } = await import("../src/mcp/mesh-groups.ts");
const { resolveCloudflareAccessPrincipal } = await import("../src/mcp/cloudflare-access.ts");
const WORKSPACE = "workspace.example";
const ACTOR = "claude-cloud:example:session_Abc123";
const DEST = "codex:11111111-1111-4111-8111-111111111111";

async function call(handler, name, args) {
  const response = await handler.fetch(new Request("https://mcp.example.test/mcp", {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name, arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "group-test", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {} }
    } })
  }), { authInfo: { token: "test", clientId: "test", scopes: [] } });
  if (response.status === 404) return { code: 404 };
  assert.equal(response.status, 200);
  const body = await response.json();
  return body.result ?? body.error;
}

test("group grants are exact, workspace-bound and reject duplicate or malformed scope", () => {
  const id = "group_" + "a".repeat(32);
  const grant = { workspace_id: WORKSPACE, session_id: ACTOR, group_ids: [id] };
  assert.equal(validGroupGrants([grant], [WORKSPACE]), true);
  assert.equal(validGroupGrants([grant, grant], [WORKSPACE]), false);
  assert.equal(validGroupGrants([{ ...grant, group_ids: [id, id] }], [WORKSPACE]), false);
  assert.equal(validGroupGrants([{ ...grant, session_id: "claude-cloud:bad:session_!" }], [WORKSPACE]), false);
  assert.equal(validGroupGrants([grant], ["workspace.other"]), false);
  const binding = { kind: "service", selector: "example", allowedTools: ["mesh_group_history"],
    allowedAgentIds: [], allowedWorkspaceIds: [WORKSPACE], allowedDomainIds: [], groupGrants: [grant] };
  const principal = resolveCloudflareAccessPrincipal({ token: "test", clientId: "test", scopes: [],
    extra: { cloudflareAccessIdentity: { subject: "test", kind: "service", selector: "example" } } }, [binding]);
  assert.deepEqual(principal.groupGrants, [grant]);
  assert.notEqual(principal.groupGrants[0].group_ids, grant.group_ids);
  assert.equal(principal.manageAllGroups, undefined);
  const manager = resolveCloudflareAccessPrincipal({ token: "test", clientId: "test", scopes: [],
    extra: { cloudflareAccessIdentity: { subject: "test", kind: "service", selector: "example" } } },
    [{ ...binding, manageAllGroups: true }]);
  assert.equal(manager.manageAllGroups, true);
});

test("authenticated group history and append traverse a private broker without cross-group access", async t => {
  const root = await mkdtemp(join(tmpdir(), "group-mcp-test-"));
  const state = join(root, "groups"), graph = join(root, "agent-mesh", "graph"), sock = join(root, "broker.sock");
  const bin = resolve("../tmux-bridge/bin"), env = { ...process.env, XDG_STATE_HOME: root, MESH_GROUPS_STATE: state,
    PYTHONDONTWRITEBYTECODE: "1" };
  const run = (program, args) => execFileSync(program, args, { env, encoding: "utf8" });
  run("node", [join(bin, "mesh-graph.mjs"), "cloud", "register", "--state", graph, "--session", ACTOR, "--evidence", "test:synthetic"]);
  const cli = (...args) => JSON.parse(run("python3", [join(bin, "mesh-groups.py"), ...args]));
  const allowed = cli("create", "Allowed").group_id, hidden = cli("create", "Hidden").group_id;
  for (const group of [allowed, hidden]) { cli("add", group, ACTOR); cli("add", group, DEST); }
  const broker = spawn("python3", [join(bin, "mesh_group_broker.py"), "--socket", sock, "--state", state], { env, stdio: "ignore" });
  t.after(async () => {
    if (broker.exitCode === null && broker.signalCode === null) {
      await new Promise(resolve => { broker.once("exit", resolve); broker.kill("SIGTERM"); });
    }
    await rm(root, { recursive: true, force: true });
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await stat(sock)).isSocket()) break; } catch { /* still starting */ }
    if (broker.exitCode !== null) throw new Error("broker exited before startup");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const groupGateway = new UnixGroupGateway(sock, 5000);
  const principal = { id: "test", kind: "service", requesterId: "mcp.test",
    allowedTools: ["mesh_group_list", "mesh_group_history", "mesh_group_append", "mesh_group_send",
      "mesh_group_lock_inspect", "mesh_group_lock_acquire", "mesh_group_lock_check", "mesh_group_lock_renew", "mesh_group_lock_release"],
    allowedAgentIds: [], allowedWorkspaceIds: [WORKSPACE], allowedDomainIds: [],
    groupGrants: [{ workspace_id: WORKSPACE, session_id: ACTOR, group_ids: [allowed] }] };
  const handler = createMeshMcpHandler({ gateway: {}, agents: [], rateLimiter: new FixedWindowMeshMcpRateLimiter(),
    groupGateway, resolvePrincipal: () => principal });
  const listed = await call(handler, "mesh_group_list", { workspace_id: WORKSPACE });
  assert.deepEqual(listed.structuredContent.groups.map(group => group.group_id), [allowed]);
  const written = await call(handler, "mesh_group_append", { workspace_id: WORKSPACE, group_id: allowed,
    message_id: "one", message: "hello" });
  assert.equal(written.structuredContent.message.author_session_id, ACTOR);
  const repeated = await call(handler, "mesh_group_append", { workspace_id: WORKSPACE, group_id: allowed,
    message_id: "one", message: "hello" });
  assert.equal(repeated.structuredContent.duplicate, true);
  const history = await call(handler, "mesh_group_history", { workspace_id: WORKSPACE, group_id: allowed });
  assert.deepEqual(history.structuredContent.messages.map(row => row.message), ["hello"]);
  const forbidden = await call(handler, "mesh_group_history", { workspace_id: WORKSPACE, group_id: hidden });
  assert.equal(forbidden.isError, true);
  const spoofed = await call(handler, "mesh_group_append", { workspace_id: WORKSPACE, group_id: allowed,
    message_id: "two", message: "bad", actor: DEST });
  assert.ok(spoofed.isError || spoofed.code);
  const invalidTarget = await call(handler, "mesh_group_send", { workspace_id: WORKSPACE, group_id: allowed,
    message_id: "three", message: "bad", destinations: ["codex:not-a-member"] });
  assert.equal(invalidTarget.isError, true);
  const adminTools = ["mesh_group_admin_list", "mesh_group_create", "mesh_group_add", "mesh_group_remove",
    "mesh_group_link", "mesh_group_unlink", "mesh_group_transfer_lead"];
  const unauthorized = createMeshMcpHandler({ gateway: {}, agents: [], rateLimiter: new FixedWindowMeshMcpRateLimiter(),
    groupGateway, resolvePrincipal: () => ({ ...principal, allowedTools: adminTools }) });
  const denied = await call(unauthorized, "mesh_group_create", { name: "Created", request_id: "request-one" });
  assert.ok(denied.isError || denied.code);
  const manager = createMeshMcpHandler({ gateway: {}, agents: [], rateLimiter: new FixedWindowMeshMcpRateLimiter(),
    groupGateway, resolvePrincipal: () => ({ ...principal, allowedTools: adminTools, manageAllGroups: true }) });
  const all = await call(manager, "mesh_group_admin_list", {});
  assert.deepEqual(new Set(all.structuredContent.groups.map(row => row.group_id)), new Set([allowed, hidden]));
  const created = await call(manager, "mesh_group_create", { name: "Created", request_id: "request-one" });
  assert.equal(created.structuredContent.created, true);
  const group = created.structuredContent.group.group_id;
  const retry = await call(manager, "mesh_group_create", { name: "Created", request_id: "request-one" });
  assert.equal(retry.structuredContent.group.group_id, group);
  assert.equal(retry.structuredContent.created, false);
  const conflicting = await call(manager, "mesh_group_create", { name: "Different", request_id: "request-one" });
  assert.equal(conflicting.isError, true);
  const added = await call(manager, "mesh_group_add", { group_id: group, session_id: ACTOR });
  assert.equal(added.structuredContent.changed, true);
  const unregistered = await call(manager, "mesh_group_add", { group_id: group,
    session_id: "claude-cloud:example:session_NotRegistered" });
  assert.equal(unregistered.isError, true);
  const linked = await call(manager, "mesh_group_link", { group_id: group, ref: "work:item-1", lead: true });
  assert.equal(linked.structuredContent.lead, true);
  const duplicateLead = await call(manager, "mesh_group_link", { group_id: allowed, ref: "work:item-1", lead: true });
  assert.equal(duplicateLead.isError, true);
  const secondLink = await call(manager, "mesh_group_link", { group_id: allowed, ref: "work:item-1" });
  assert.equal(secondLink.structuredContent.lead, false);
  const transfer = await call(manager, "mesh_group_transfer_lead", { ref: "work:item-1",
    from_group_id: group, to_group_id: allowed });
  assert.equal(transfer.structuredContent.changed, true);
  const staleTransfer = await call(manager, "mesh_group_transfer_lead", { ref: "work:item-1",
    from_group_id: group, to_group_id: allowed });
  assert.equal(staleTransfer.isError, true);
  const unlinked = await call(manager, "mesh_group_unlink", { group_id: group, ref: "work:item-1" });
  assert.equal(unlinked.structuredContent.changed, true);
  const lockArgs = { workspace_id: WORKSPACE, group_id: allowed, ref: "work:item-1" };
  const inspect = await call(handler, "mesh_group_lock_inspect", lockArgs);
  assert.equal(inspect.structuredContent.fence, 0);
  const acquired = await call(handler, "mesh_group_lock_acquire", { ...lockArgs, fence: 0, ttl: 60 });
  assert.equal(acquired.structuredContent.outcome, "acquired");
  assert.equal(acquired.structuredContent.owner, ACTOR);
  const firstFence = acquired.structuredContent.fence;
  const firstLease = acquired.structuredContent.leaseId;
  const visible = await call(handler, "mesh_group_lock_inspect", lockArgs);
  assert.equal(visible.structuredContent.leaseId, undefined);
  const spoofedLock = await call(handler, "mesh_group_lock_acquire", { ...lockArgs, fence: firstFence, ttl: 60, owner: DEST });
  assert.ok(spoofedLock.isError || spoofedLock.code);
  const other = createMeshMcpHandler({ gateway: {}, agents: [], rateLimiter: new FixedWindowMeshMcpRateLimiter(),
    groupGateway, resolvePrincipal: () => ({ ...principal,
      groupGrants: [{ workspace_id: WORKSPACE, session_id: DEST, group_ids: [allowed] }] }) });
  const held = await call(other, "mesh_group_lock_acquire", { ...lockArgs, fence: firstFence, ttl: 60 });
  assert.equal(held.structuredContent.outcome, "held");
  const stolen = await call(other, "mesh_group_lock_check", { ...lockArgs, fence: firstFence, lease_id: firstLease });
  assert.equal(stolen.structuredContent.outcome, "stale");
  const checked = await call(handler, "mesh_group_lock_check", { ...lockArgs, fence: firstFence, lease_id: firstLease });
  assert.equal(checked.structuredContent.outcome, "current");
  const renewed = await call(handler, "mesh_group_lock_renew", { ...lockArgs, fence: firstFence, lease_id: firstLease, ttl: 60 });
  assert.equal(renewed.structuredContent.outcome, "renewed");
  const released = await call(handler, "mesh_group_lock_release", { ...lockArgs, fence: firstFence, lease_id: firstLease });
  assert.equal(released.structuredContent.outcome, "released");
  const reacquired = await call(other, "mesh_group_lock_acquire", { ...lockArgs, fence: firstFence, ttl: 60 });
  assert.equal(reacquired.structuredContent.fence, firstFence + 1);
  const stale = await call(handler, "mesh_group_lock_release", { ...lockArgs, fence: firstFence, lease_id: firstLease });
  assert.equal(stale.structuredContent.outcome, "stale");
  const otherRelease = await call(other, "mesh_group_lock_release", { ...lockArgs,
    fence: reacquired.structuredContent.fence, lease_id: reacquired.structuredContent.leaseId });
  assert.equal(otherRelease.structuredContent.outcome, "released");
  const unrelatedLock = await call(handler, "mesh_group_lock_inspect", { ...lockArgs, ref: "work:other" });
  assert.equal(unrelatedLock.isError, true);
  const incompatible = await call(manager, "mesh_group_link", { group_id: group, ref: "work.test:item-1" });
  assert.ok(incompatible.isError || incompatible.code);
  const removed = await call(manager, "mesh_group_remove", { group_id: group, session_id: ACTOR });
  assert.equal(removed.structuredContent.changed, true);
  for (let i = 0; i < 11; i++) {
    const item = await call(handler, "mesh_group_append", { workspace_id: WORKSPACE, group_id: allowed,
      message_id: `page-${i}`, message: `reply ${i}` });
    assert.equal(item.isError, undefined);
  }
  const firstPage = await call(handler, "mesh_group_history", { workspace_id: WORKSPACE, group_id: allowed });
  assert.equal(firstPage.structuredContent.messages.length, 10);
  assert.equal(firstPage.structuredContent.has_more, true);
  const secondPage = await call(handler, "mesh_group_history", { workspace_id: WORKSPACE, group_id: allowed,
    after: firstPage.structuredContent.next_after });
  assert.equal(secondPage.structuredContent.messages.length, 2);
  cli("remove", allowed, ACTOR);
  const revoked = await call(handler, "mesh_group_history", { workspace_id: WORKSPACE, group_id: allowed });
  assert.equal(revoked.isError, true);
  const revokedLock = await call(handler, "mesh_group_lock_inspect", lockArgs);
  assert.equal(revokedLock.isError, true);
});
