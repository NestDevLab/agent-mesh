import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const graphBin = join(packageRoot, "bin", "mesh-graph.mjs");
const CLAUDE = "11111111-1111-4111-8111-111111111111";
const CODEX = "22222222-2222-4222-8222-222222222222";
const RENEWED = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";

async function run(state, args, environment = {}) {
  try {
    const result = await exec(process.execPath, [graphBin, "--state", state, ...args], { env: { ...process.env, MESH_PLEXUS_HOST: "test-host", ...environment } });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function ok(state, args, environment) {
  const result = await run(state, args.includes("--json") || args[0] === "query" ? args : [...args, "--json"], environment);
  assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

async function query(state, name, input, environment) {
  return ok(state, ["query", name, "--input", JSON.stringify(input)], environment);
}

async function seed(state) {
  await ok(state, ["add", "--agent", "claude", "--tmux-target", "t-claude", "--cwd", "/work/space-a/app", "--runtime-uuid", CLAUDE, "--refs", "flow:space-a/work-item/1", "--json"]);
  await ok(state, ["add", "--agent", "codex", "--tmux-target", "t-codex", "--cwd", "/work/space-a/app", "--runtime-uuid", CODEX, "--json"]);
  await ok(state, ["add", "--agent", "codex", "--tmux-target", "t-other", "--cwd", "/work/space-b/app", "--runtime-uuid", OTHER, "--json"]);
  await ok(state, ["add", "--agent", "claude", "--tmux-target", "t-pending", "--cwd", "/work/space-a/app", "--refs", "flow:space-a/work-item/2", "--json"]);
}

const scopeA = {
  refPrefixes: ["flow:space-a/", "chat:space-a/"],
  targets: [{ id: "agent-a-claude", harness: "claude", roots: ["/work/space-a"] }, { id: "agent-a-codex", harness: "codex", roots: ["/work/space-a"] }],
  handleKey: "space-a-handle-key-0123456789",
};

test("migrate numbers legacy events, opens legacy links once and keeps refs as a projection", async () => {
  const state = await mkdtemp(join(tmpdir(), "plexus-"));
  try {
    await seed(state);
    const refused = await run(state, ["link", "open", "--agent", "codex", "--runtime-uuid", CODEX, "--ref", "flow:space-a/work-item/1"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /migrated store/);

    const dry = await ok(state, ["migrate"]);
    assert.deepEqual([dry.migration, dry.events, dry.links], ["dry-run", 4, 2]);
    const applied = await ok(state, ["migrate", "--apply"]);
    assert.equal(applied.migration, "applied");
    assert.equal((await ok(state, ["migrate", "--apply"])).migration, "already-migrated");

    const lines = (await readFile(join(state, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((item) => item.seq), lines.map((_, index) => index + 1));
    assert.equal(lines.at(-1).type, "store.migrated");

    const graph = await ok(state, ["show", "--json"]);
    const legacy = graph.links.filter((link) => link.source === "legacy-node-refs");
    assert.deepEqual(legacy.map((link) => link.session).sort(), [`claude:${CLAUDE}`, `pending:${graph.nodes.find((node) => node.tmuxTarget === "t-pending").id}`].sort());

    await ok(state, ["ref", "add", "--runtime-uuid", CODEX, "--ref", "flow:space-a/work-item/1", "--json"]);
    await ok(state, ["ref", "remove", "--runtime-uuid", CLAUDE, "--ref", "flow:space-a/work-item/1", "--json"]);
    const after = await ok(state, ["show", "--json"]);
    assert.deepEqual(after.nodes.find((node) => node.runtimeUuid === CODEX).refs, ["flow:space-a/work-item/1"]);
    assert.deepEqual(after.nodes.find((node) => node.runtimeUuid === CLAUDE).refs, []);
    assert.ok(after.links.some((link) => link.session === `claude:${CLAUDE}` && link.until !== null));
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test("pending links resolve when the node learns its runtime UUID, merging into an open link", async () => {
  const state = await mkdtemp(join(tmpdir(), "plexus-"));
  try {
    await seed(state);
    await ok(state, ["migrate", "--apply"]);
    await ok(state, ["link", "open", "--agent", "claude", "--runtime-uuid", RENEWED, "--ref", "flow:space-a/work-item/2", "--role", "works-on"]);
    await ok(state, ["add", "--tmux-target", "t-pending", "--runtime-uuid", RENEWED, "--json"]);
    const graph = await ok(state, ["show", "--json"]);
    const open = graph.links.filter((link) => link.ref === "flow:space-a/work-item/2" && link.until === null);
    assert.equal(open.length, 1);
    assert.equal(open[0].session, `claude:${RENEWED}`);
    const merged = graph.links.find((link) => link.mergedInto === open[0].id);
    assert.ok(merged, "pending link closes with mergedInto");
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test("Oikuma acceptance: links, neighbours with redaction, renewal and resume info", async () => {
  const state = await mkdtemp(join(tmpdir(), "plexus-"));
  const stubDir = await mkdtemp(join(tmpdir(), "plexus-writer-"));
  try {
    await seed(state);
    await ok(state, ["migrate", "--apply"]);
    const item = "flow:space-a/work-item/1";
    await ok(state, ["link", "open", "--agent", "codex", "--runtime-uuid", CODEX, "--ref", item, "--role", "reviews", "--source", "ui:space-a"]);
    await ok(state, ["link", "open", "--agent", "codex", "--runtime-uuid", OTHER, "--ref", item, "--role", "observes"]);
    await ok(state, ["link", "open", "--agent", "codex", "--runtime-uuid", CODEX, "--ref", "flow:space-b/hidden/9"]);
    await ok(state, ["link", "open", "--agent", "codex", "--runtime-uuid", OTHER, "--ref", "flow:space-b/hidden/9"]);

    // 1. Q1 returns both sessions, Q2 on each returns the item.
    const q1 = await query(state, "ledger-sessions", { ref: item, scope: scopeA });
    const visibleIds = q1.sessions.filter((session) => !session.redacted).map((session) => session.sessionId);
    assert.deepEqual(visibleIds, [`claude:${CLAUDE}`, `codex:${CODEX}`]);
    assert.equal(q1.sessions.filter((session) => session.redacted).length, 1);
    for (const session of visibleIds) {
      const q2 = await query(state, "session-ledgers", { session, scope: scopeA });
      assert.deepEqual(q2.links.map((link) => link.ref), [item]);
    }

    // 4. A neighbour outside the Space is redacted; hidden refs never appear in breakdowns.
    const q3 = await query(state, "neighbours", { session: `codex:${CODEX}`, depth: 2, scope: scopeA });
    const redacted = q3.neighbours.find((entry) => entry.redacted);
    assert.ok(redacted && /^h-[0-9a-f]{24}$/.test(redacted.handle));
    assert.equal(redacted.breakdown, undefined);
    assert.ok(!JSON.stringify(q3).includes("space-b"));
    const claude = q3.neighbours.find((entry) => entry.sessionId === `claude:${CLAUDE}`);
    assert.equal(claude.breakdown.refs[0].ref, item);
    const unscoped = await query(state, "neighbours", { session: `codex:${CODEX}` });
    assert.ok(unscoped.neighbours.find((entry) => entry.sessionId === `codex:${OTHER}`).breakdown.refs.some((entry) => entry.ref === "flow:space-b/hidden/9"));
    const hiddenSession = await run(state, ["query", "session-ledgers", "--input", JSON.stringify({ session: `codex:${OTHER}`, scope: scopeA })]);
    assert.notEqual(hiddenSession.code, 0);
    assert.match(hiddenSession.stderr, /not found/);

    // 3. An occupied session is not resumable.
    const stub = join(stubDir, "writer.mjs");
    await writeFile(stub, "console.log(JSON.stringify({ agent: 'claude', state: 'owned', writers: [{ kind: 'claude-cli', pid: 1 }] }));\n");
    await chmod(stub, 0o755);
    const q5 = await query(state, "resume", { session: `claude:${CLAUDE}`, scope: scopeA }, { MESH_PLEXUS_WRITER_STATUS: stub });
    assert.equal(q5.resumable, false);
    assert.equal(q5.writer.state, "occupied");
    assert.equal(q5.reason, "occupied");
    assert.deepEqual(q5.commands[0].argv, ["claude", "--resume", CLAUDE]);
    assert.equal(q5.host, "test-host");

    // 2. Renewal: Q5 on the old id returns the successor.
    await ok(state, ["add", "--agent", "claude", "--tmux-target", "t-renewed", "--cwd", "/work/space-a/app", "--runtime-uuid", RENEWED, "--refs", item, "--json"]);
    await ok(state, ["renew", "--from", `claude:${CLAUDE}`, "--to", `claude:${RENEWED}`]);
    await writeFile(stub, "console.log(JSON.stringify({ agent: 'claude', state: 'free', writers: [] }));\n");
    const old = await query(state, "resume", { session: `claude:${CLAUDE}`, scope: scopeA }, { MESH_PLEXUS_WRITER_STATUS: stub });
    assert.deepEqual(old.successor, { sessionId: `claude:${RENEWED}` });
    assert.ok(old.reasons.includes("superseded"));
    const renewedQ1 = await query(state, "ledger-sessions", { ref: item, scope: scopeA });
    assert.ok(renewedQ1.sessions.some((session) => session.sessionId === `claude:${RENEWED}`));

    const subgraph = await query(state, "subgraph", { refs: [item], depth: 1, scope: scopeA });
    assert.ok(subgraph.links.every((link) => link.ref.startsWith("flow:space-a/")));
    const search = await query(state, "search", { harness: "codex", scope: scopeA });
    assert.deepEqual(search.sessions.map((session) => session.sessionId), [`codex:${CODEX}`]);
  } finally {
    await rm(state, { recursive: true, force: true });
    await rm(stubDir, { recursive: true, force: true });
  }
});

test("Q7 replays from an old cursor with identical event ids and resets past the retention watermark", async () => {
  const state = await mkdtemp(join(tmpdir(), "plexus-"));
  try {
    await seed(state);
    await ok(state, ["migrate", "--apply"]);
    const start = (await query(state, "changes", {})).cursor;
    const item = "flow:space-a/work-item/1";
    await ok(state, ["link", "open", "--agent", "codex", "--runtime-uuid", CODEX, "--ref", item]);
    await ok(state, ["summary", "--id", (await ok(state, ["show", "--json"])).nodes.find((node) => node.runtimeUuid === CODEX).id, "--summary", "waiting", "--status", "waiting", "--json"]);
    await ok(state, ["link", "close", "--agent", "codex", "--runtime-uuid", CODEX, "--ref", item]);

    const first = await query(state, "changes", { sinceCursor: start, scope: scopeA });
    assert.deepEqual(first.events.map((entry) => entry.type), ["edge.added", "session.state_changed", "edge.ended"]);
    assert.ok(first.events.every((entry) => entry.host === "test-host"));
    const again = await query(state, "changes", { sinceCursor: start, scope: scopeA });
    assert.deepEqual(again.events.map((entry) => entry.eventId), first.events.map((entry) => entry.eventId));
    const paged = await query(state, "changes", { sinceCursor: start, limit: 1, scope: scopeA });
    assert.equal(paged.events.length, 1);
    const rest = await query(state, "changes", { sinceCursor: paged.cursor, scope: scopeA });
    assert.deepEqual([...paged.events, ...rest.events].map((entry) => entry.eventId), first.events.map((entry) => entry.eventId));
    const filtered = await query(state, "changes", { sinceCursor: start, refs: ["flow:space-a/other"], scope: scopeA });
    assert.deepEqual(filtered.events, []);

    await ok(state, ["compact", "--all-history", "--apply", "--json"]);
    const reset = await query(state, "changes", { sinceCursor: start });
    assert.equal(reset.reset, true);
    assert.equal((await query(state, "ledger-sessions", { ref: item, history: true })).sessions.length, 2);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});
