import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import "./ts-extension-resolver.mjs";
const { AuthorizationJournal, assertionDigest } = await import("../src/mcp/authorization-journal.ts");
const { createOikumaPlexusHandler } = await import("../src/mcp/oikuma-plexus-profile.ts");
const { CloudflareAccessAuthenticator, cloudflarePrincipalId } = await import("../src/mcp/cloudflare-access.ts");
const { FixedWindowMeshMcpRateLimiter } = await import("../src/mcp/mesh-mcp.ts");

const selector = "owner@example.test";
const ownerPrincipalId = cloudflarePrincipalId("user", selector);
const policy = { ownerPrincipalId, bindings: [{ kind: "user", selector,
  allowedTools: ["mesh_plexus_work_items", "mesh_plexus_ledger_sessions"], allowedAgentIds: [],
  allowedWorkspaceIds: ["workspace.test"], allowedDomainIds: [],
  ledgerReadGrants: [{ workspace_id: "workspace.test", ledger_refs: ["work:TEST-1"], session_ids: [] }] }] };
const identity = { subject: "test-user", kind: "user", selector };
const auth = { token: "synthetic-assertion", clientId: identity.subject, scopes: [], extra: { cloudflareAccessIdentity: identity } };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "mesh-auth-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "authorization.jsonl");
  return { path, journal: new AuthorizationJournal(path) };
}

test("authorization history uses CAS and advances through revoke, restore and identical replacement", async t => {
  const { path, journal } = await fixture(t);
  await assert.rejects(journal.resolvePrincipal(auth));
  assert.equal(await journal.replace(0, policy), 1);
  const baseline = await readFile(path, "utf8");
  assert.equal((await journal.resolvePrincipal(auth)).authorizationRevision, 1);
  await assert.rejects(journal.replace(0, policy), /conflict/);
  assert.equal(await journal.replace(1, { ...policy, bindings: [] }), 2);
  await assert.rejects(journal.resolvePrincipal(auth));
  assert.equal(await journal.replace(2, policy), 3);
  assert.equal((await new AuthorizationJournal(path).resolvePrincipal(auth)).authorizationRevision, 3);
  assert.equal(await journal.replace(3, policy), 4);
  await writeFile(path, baseline);
  await assert.rejects(journal.resolvePrincipal(auth), /regressed/);
});

test("assertion revocation survives policy restore and a fresh authority instance", async t => {
  const { path, journal } = await fixture(t);
  await journal.replace(0, policy);
  await journal.replace(1, policy, [assertionDigest(auth.token)]);
  await journal.replace(2, policy);
  await assert.rejects(new AuthorizationJournal(path).resolvePrincipal(auth), /unavailable/);
  assert.equal((await journal.resolvePrincipal({ ...auth, token: "different-synthetic-assertion" })).authorizationRevision, 3);
});

test("partial history, revision reuse and concurrent writer admission fail closed", async t => {
  const { path, journal } = await fixture(t);
  await journal.replace(0, policy);
  const original = await readFile(path, "utf8");
  await writeFile(`${path}.lock`, "");
  await assert.rejects(journal.replace(1, policy), { code: "EEXIST" });
  assert.equal(await readFile(path, "utf8"), original);
  await writeFile(path, original + "{");
  await assert.rejects(journal.resolvePrincipal(auth), /Incomplete/);
  await writeFile(path, original + original);
  await assert.rejects(journal.resolvePrincipal(auth), /Invalid/);
});

test("signed unexpired requests deny in-flight revoke/restore and persisted assertion revocation", async t => {
  const { path, journal } = await fixture(t);
  await journal.replace(0, policy);
  const issuer = "https://access.example.test", audience = "synthetic-audience";
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...await exportJWK(publicKey), kid: "auth-test", alg: "ES256" };
  t.mock.method(globalThis, "fetch", async () => Response.json({ keys: [jwk] }));
  const expiresAt = Math.floor(Date.now() / 1000) + 300;
  const token = await new SignJWT({ sub: identity.subject, email: selector, iss: issuer, aud: audience, exp: expiresAt })
    .setProtectedHeader({ alg: "ES256", kid: "auth-test" }).sign(privateKey);
  const request = (args = {}) => new Request("https://gateway.example.test/oikuma", { method: "POST",
    headers: { "cf-access-jwt-assertion": token, "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "mesh_plexus_work_items" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mesh_plexus_work_items", arguments: args,
      _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {} } } }) });
  let hold = false, reads = 0, entered, release;
  let ready;
  const options = { gateway: {}, agents: [], rateLimiter: new FixedWindowMeshMcpRateLimiter(),
    resolvePrincipal: input => journal.resolvePrincipal(input),
    plexusLedgerReader: { async read() { reads++; if (hold) { entered(); await new Promise(r => release = r); }
      return { items: [{ ref: "work:TEST-1" }, { ref: "work:TEST-1" }], refs: [], sessions: [], count: 1 }; } } };
  const create = opts => createOikumaPlexusHandler(opts, new CloudflareAccessAuthenticator({ teamDomain: issuer, audience }));
  const handler = create(options);
  const first = await (await handler.fetch(request({ limit: 1 }))).json();
  const cursor = JSON.parse(first.result.content[0].text).next_cursor;
  assert.ok(cursor);
  ready = new Promise(r => entered = r); hold = true;
  const pending = handler.fetch(request()); await ready;
  await journal.replace(1, { ...policy, bindings: [] });
  await journal.replace(2, policy); release();
  const revoked = await pending;
  assert.equal(revoked.status, 403); assert.doesNotMatch(await revoked.text(), /TEST-1/);
  hold = false;
  const stale = await (await handler.fetch(request({ limit: 1, cursor }))).json();
  assert.equal(stale.result.isError, true, "restore must not revive an old cursor");
  assert.equal((await handler.fetch(request())).status, 200);
  await journal.replace(3, policy, [assertionDigest(token)]);
  assert.ok(expiresAt > Date.now() / 1000, "revocation must be qualified before expiry");
  const before = reads;
  assert.equal((await create({ ...options, resolvePrincipal: input => new AuthorizationJournal(path).resolvePrincipal(input) }).fetch(request())).status, 403);
  assert.equal(reads, before, "revoked assertion must not reach upstream");
  assert.equal((await create({ ...options, resolvePrincipal: async input => {
    const principal = await journal.resolvePrincipal({ ...input, token: "new-synthetic-assertion" });
    delete principal.authorizationRevision; return principal;
  } }).fetch(request())).status, 403);
});
