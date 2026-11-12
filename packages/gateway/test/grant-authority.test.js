import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./ts-extension-resolver.mjs";
const authorityUrl = new URL("../src/mcp/grant-authority.ts", import.meta.url).href;
const cliUrl = new URL("../src/mcp/grant-authority-cli.ts", import.meta.url);
const { authorizationProjection, authorizationDigest, init, commit, readAuthority, verify, reincarnate } = await import(authorityUrl);
const details = { actor: "test-operator", reason: "synthetic grant update" };
const config = () => ({ bindings: [{ kind: "service", selector: "synthetic-service", allowedTools: ["mesh_plexus_work_items"],
  allowedAgentIds: [], allowedWorkspaceIds: ["workspace.example"], allowedDomainIds: [],
  ledgerReadGrants: [{ workspace_id: "workspace.example", ledger_refs: ["work:EXAMPLE-1"], session_ids: [] }] }],
  plexusLedger: { ownerPrincipalId: "synthetic-owner" } });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "grant-authority-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "config.json");
  const live = config();
  await writeFile(path, JSON.stringify(live));
  return { dir, path, live };
}
function run(source, args = []) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

test("projection sorts keys, preserves array order and ignores unrelated configuration", () => {
  const live = config();
  const reordered = JSON.parse(JSON.stringify(live), (key, value) => value && !Array.isArray(value) && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).reverse()) : value);
  assert.equal(authorizationProjection(live), authorizationProjection(reordered));
  assert.equal(authorizationDigest(live), authorizationDigest({ ...live, stateDir: "synthetic-state", workspaceWorkers: [1],
    agents: [{ id: "synthetic-agent" }], plexusLedger: { ...live.plexusLedger, bridgeRoot: "synthetic-bridge" } }));
  for (const [key, value] of Object.entries({ kind: "user", selector: "changed", allowedTools: [], allowedAgentIds: ["a"],
    allowedWorkspaceIds: [], allowedDomainIds: ["d"], ledgerReadGrants: [], returnRoutes: [], groupGrants: [],
    manageAllGroups: true, plexusLedgerReadDelegate: true, allowedGoogleAccounts: ["work"] })) {
    const changed = structuredClone(live);
    changed.bindings[0][key] = value;
    assert.notEqual(authorizationDigest(live), authorizationDigest(changed), key);
  }
  assert.notEqual(authorizationDigest(live), authorizationDigest({ ...live, bindings: [] }));
  assert.notEqual(authorizationDigest(live), authorizationDigest({ ...live, plexusLedger: { ownerPrincipalId: "other-owner" } }));
});

test("init refuses existing state; identical regrant always advances revision", async t => {
  const { dir, path, live } = await fixture(t);
  const initial = await init(dir);
  assert.equal(initial.revision, "1");
  assert.match(initial.incarnation, /^[0-9a-f-]{14}4[0-9a-f-]{21}$/);
  assert.deepEqual(await verify(dir, live), { ok: false, reason: "digest_mismatch" });
  await assert.rejects(init(dir), /state_exists/);
  const first = await commit(dir, path, details);
  const second = await commit(dir, path, details);
  assert.equal(first.revision, "2");
  assert.equal(second.revision, "3");
  assert.equal(second.digest, first.digest);
  assert.equal(second.incarnation, initial.incarnation);
  assert.deepEqual(await verify(dir, live), { ok: true, incarnation: second.incarnation, revision: "3", digest: second.digest });
  const journal = (await readFile(join(dir, "journal.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(journal.map(line => [line.revision, line.previousRevision]), [["1", null], ["2", "1"], ["3", "2"]]);
  assert.equal(journal[2].actor, details.actor);
  assert.equal(journal[2].reason, details.reason);
});

test("restoring an old config needs a commit above every published revision", async t => {
  const { dir, path, live } = await fixture(t);
  await init(dir);
  const first = await commit(dir, path, details);
  const revoked = { ...live, bindings: [] };
  await writeFile(path, JSON.stringify(revoked));
  const second = await commit(dir, path, details);
  await writeFile(path, JSON.stringify(live));
  assert.deepEqual(await verify(dir, live), { ok: false, reason: "digest_mismatch" });
  const restored = await commit(dir, path, details);
  assert.equal(restored.digest, first.digest);
  assert.ok(BigInt(restored.revision) > BigInt(second.revision));
  assert.equal((await verify(dir, live)).ok, true);
});

for (const mode of ["missing", "corrupt", "unknown-format", "overflow", "above-u64", "negative", "noncanonical"]) {
  test(`${mode} authority fails closed without leaking content`, async t => {
    const { dir, path, live } = await fixture(t);
    if (mode !== "missing") {
      const state = await init(dir);
      if (mode === "corrupt") await writeFile(join(dir, "state.json"), "private-fixture invalid JSON");
      else {
        if (mode === "unknown-format") state.format = "unsupported";
        else state.revision = { overflow: "18446744073709551615", "above-u64": "18446744073709551616", negative: "-1", noncanonical: "01" }[mode];
        await writeFile(join(dir, "state.json"), JSON.stringify(state));
      }
      await assert.rejects(init(dir), /state_exists/);
    }
    const before = await readAuthority(dir);
    assert.equal(before.ok, false);
    assert.equal((await verify(dir, live)).ok, false);
    assert.ok(!JSON.stringify(before).includes("private-fixture"));
    await assert.rejects(commit(dir, path, details), error => !error.message.includes("private-fixture"));
  });
}

test("a crash after journal fsync but before state rename retains the previous committed view", async t => {
  const { dir, path, live } = await fixture(t);
  await init(dir);
  const before = await commit(dir, path, details);
  const revoked = { ...live, bindings: [] };
  await writeFile(path, JSON.stringify(revoked));
  const next = { ...before, revision: "3", digest: authorizationDigest(revoked) };
  const crash = run(`
    import { open } from 'node:fs/promises';
    import { join } from 'node:path';
    const dir = process.argv[1], next = JSON.parse(process.argv[2]);
    const journal = await open(join(dir, 'journal.jsonl'), 'a');
    await journal.writeFile(JSON.stringify({ incarnation: next.incarnation, revision: next.revision,
      previousRevision: '2', digest: next.digest, actor: 'crash-fixture', reason: 'crash simulation', at: next.committedAt }) + '\\n');
    await journal.sync(); await journal.close();
    const temporary = await open(join(dir, '.crash-state.tmp'), 'wx');
    await temporary.writeFile(JSON.stringify(next)); await temporary.sync();
    process.exit(79);
  `, [dir, JSON.stringify(next)]);
  assert.equal((await crash.done).code, 79);
  assert.equal((await readAuthority(dir)).revision, "2");
  assert.equal((await verify(dir, live)).ok, true);
  assert.deepEqual(await verify(dir, revoked), { ok: false, reason: "digest_mismatch" });
  assert.equal(JSON.parse((await readFile(join(dir, "journal.jsonl"), "utf8")).trim().split("\n").at(-1)).revision, "3");
});

test("two child writers contend on a held lock and serialize increasing revisions", { timeout: 30000 }, async t => {
  const { dir, path } = await fixture(t);
  await init(dir);
  const holder = spawn("flock", ["--exclusive", join(dir, "writer.lock"), process.execPath, "-e",
    'process.stdout.write("held\\n"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0));']);
  t.after(() => holder.kill());
  await new Promise((resolve, reject) => {
    holder.stdout.once("data", resolve);
    holder.once("error", reject);
    holder.once("exit", () => reject(new Error("holder exited")));
  });
  const source = `
    const { commit } = await import(${JSON.stringify(authorityUrl)});
    process.stdout.write('ready\\n');
    const revisions = [];
    for (let i = 0; i < 8; i++) revisions.push((await commit(process.argv[1], process.argv[2],
      { actor: 'child-writer', reason: 'contention fixture' })).revision);
    process.stdout.write(JSON.stringify(revisions) + '\\n');
  `;
  const writers = [run(source, [dir, path]), run(source, [dir, path])];
  t.after(() => writers.forEach(writer => writer.child.kill()));
  await Promise.all(writers.map(writer => new Promise((resolve, reject) => {
    writer.child.stdout.once("data", resolve);
    writer.child.once("error", reject);
    writer.child.once("exit", () => reject(new Error("writer exited before ready")));
  })));
  assert.equal((await readAuthority(dir)).revision, "1");
  holder.stdin.end();
  const results = await Promise.all(writers.map(writer => writer.done));
  const revisions = results.flatMap(result => {
    assert.equal(result.code, 0, result.stderr);
    const sequence = JSON.parse(result.stdout.trim().split("\n").at(-1)).map(Number);
    assert.ok(sequence.every((revision, index) => index === 0 || revision > sequence[index - 1]));
    return sequence;
  }).sort((a, b) => a - b);
  assert.deepEqual(revisions, Array.from({ length: 16 }, (_, index) => index + 2));
  const journal = (await readFile(join(dir, "journal.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(journal.map(line => Number(line.revision)), Array.from({ length: 17 }, (_, index) => index + 1));
});

test("explicit recovery changes incarnation, journals the reason and needs a fresh commit", async t => {
  const { dir, path, live } = await fixture(t);
  const before = await init(dir);
  await writeFile(join(dir, "state.json"), "corrupt fixture");
  const recovered = await reincarnate(dir, { reason: "synthetic snapshot recovery" });
  assert.notEqual(recovered.incarnation, before.incarnation);
  assert.equal(recovered.revision, "1");
  assert.equal((await verify(dir, live)).ok, false);
  await commit(dir, path, details);
  assert.equal((await verify(dir, live)).ok, true);
  const journal = (await readFile(join(dir, "journal.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(journal[1].reason, "synthetic snapshot recovery");
});

test("CLI defaults to config stateDir and status succeeds only after commit", async t => {
  const { dir, path, live } = await fixture(t);
  await writeFile(path, JSON.stringify({ ...live, stateDir: dir }));
  const cli = args => run(`process.argv = [process.execPath, ${JSON.stringify(cliUrl.pathname)}, ...JSON.parse(process.argv[1])];
    await import(${JSON.stringify(cliUrl.href)});`, [JSON.stringify(args)]).done;
  assert.equal((await cli(["init", "--config", path])).code, 0);
  const uncommitted = await cli(["status", "--config", path]);
  assert.equal(uncommitted.code, 1);
  assert.equal(JSON.parse(uncommitted.stdout).reason, "digest_mismatch");
  assert.equal((await cli(["commit", "--config", path, "--reason", "synthetic CLI update"])).code, 0);
  const status = await cli(["status", "--config", path]);
  assert.equal(status.code, 0);
  assert.equal(JSON.parse(status.stdout).revision, "2");
});
