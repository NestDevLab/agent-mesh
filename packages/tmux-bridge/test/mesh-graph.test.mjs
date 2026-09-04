import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const graphBin = join(packageRoot, "bin", "mesh-graph.mjs");

async function run(state, args, environment = {}) {
  try {
    const result = await exec(process.execPath, [graphBin, "--state", state, ...args], {
      env: { ...process.env, ...environment },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("mesh-graph derives an inspectable graph from append-only events", async () => {
  const state = await mkdtemp(join(tmpdir(), "mesh-graph-"));
  try {
    const first = await run(state, [
      "add", "--agent", "codex", "--tmux-target", "mesh-codex-main", "--cwd", "/workspace/mesh",
      "--role-profile", "developer", "--title", "Graph work", "--summary", "initial implementation",
      "--refs", "management:MGT-0239,amf:record-id", "--json",
    ]);
    assert.equal(first.code, 0, first.stderr);
    const firstNode = JSON.parse(first.stdout).node;
    assert.match(firstNode.id, /^node-[0-9a-f-]{36}$/);
    assert.equal(firstNode.runtimeUuid, null);
    assert.deepEqual(firstNode.refs, ["management:MGT-0239", "amf:record-id"]);

    const reconciled = await run(state, [
      "add", "--tmux-target", "mesh-codex-main", "--runtime-uuid", "11111111-1111-4111-8111-111111111111", "--json",
    ]);
    assert.equal(reconciled.code, 0, reconciled.stderr);
    assert.equal(JSON.parse(reconciled.stdout).node.id, firstNode.id);

    const second = await run(state, [
      "add", "--agent", "claude", "--tmux-target", "mesh-claude-po", "--cwd", "/workspace/mesh", "--summary", "PO", "--json",
    ]);
    assert.equal(second.code, 0, second.stderr);
    const secondNode = JSON.parse(second.stdout).node;

    const link = await run(state, ["link", "--from", firstNode.id, "--to", secondNode.id, "--type", "delegates-to", "--json"]);
    assert.equal(link.code, 0, link.stderr);
    assert.equal(JSON.parse(link.stdout).edge.type, "delegates-to");

    const summary = await run(state, ["summary", "--id", firstNode.id, "--summary", "awaiting review", "--status", "waiting", "--json"]);
    assert.equal(summary.code, 0, summary.stderr);
    assert.equal(JSON.parse(summary.stdout).node.status, "waiting");

    const closed = await run(state, ["close", "--id", secondNode.id, "--json"]);
    assert.equal(closed.code, 0, closed.stderr);
    assert.equal(JSON.parse(closed.stdout).node.status, "closed");

    const shown = await run(state, ["show", "--json"]);
    assert.equal(shown.code, 0, shown.stderr);
    const graph = JSON.parse(shown.stdout);
    assert.equal(graph.schema, "agent-mesh.session-graph.v1");
    assert.equal(graph.nodes.length, 2);
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.nodes.find((node) => node.id === firstNode.id).runtimeUuid, "11111111-1111-4111-8111-111111111111");
    assert.deepEqual(graph.nodes.find((node) => node.id === firstNode.id).refs, ["management:MGT-0239", "amf:record-id"]);
    assert.equal(graph.nodes.find((node) => node.id === secondNode.id).status, "closed");

    const projection = JSON.parse(await readFile(join(state, "graph.json"), "utf8"));
    assert.deepEqual(projection.nodes, graph.nodes);
    const events = (await readFile(join(state, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(events.length, 6);
    assert.ok(events.every((event) => event.schema === "agent-mesh.session-graph-event.v1"));

    const tree = await run(state, ["show", "--tree"]);
    assert.equal(tree.code, 0, tree.stderr);
    assert.match(tree.stdout, new RegExp(firstNode.id));
    assert.match(tree.stdout, /delegates-to:/);

    const compact = await run(state, ["show", "--compact"]);
    assert.equal(compact.code, 0, compact.stderr);
    assert.match(compact.stdout, /awaiting review/);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test("mesh-graph adopts a Desktop transcript by runtime UUID without inventing a summary", async () => {
  const state = await mkdtemp(join(tmpdir(), "mesh-graph-adopt-"));
  const transcripts = await mkdtemp(join(tmpdir(), "mesh-graph-transcripts-"));
  // Real locally observed runtime UUID shapes: Codex Desktop v7 and Claude v4.
  const sessionId = "01a06ccf-134d-7cf0-9611-42819810e4ed";
  const claudeId = "ef6791f1-24a5-43cf-8f26-6733ecfda183";
  try {
    const directory = join(transcripts, "2026", "09", "04");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `rollout-${sessionId}.jsonl`), [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/workspace/desktop" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "First objective\n\nSupporting context stays raw." }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Investigating." }] } }),
    ].join("\n") + "\n");
    const domainRoots = join(transcripts, "domains.json");
    await writeFile(domainRoots, JSON.stringify({ domains: [{ domain: "desktop", root: "/workspace/desktop" }] }));
    const environment = { CODEX_SESSION_ROOT: transcripts };
    const domainEnvironment = { ...environment, MESH_DOMAIN_ROOTS_FILE: domainRoots };
    const adopted = await run(state, ["adopt", "--agent", "codex", "--runtime-uuid", sessionId, "--class", "worker", "--json"], environment);
    assert.equal(adopted.code, 0, adopted.stderr);
    const node = JSON.parse(adopted.stdout).node;
    assert.match(node.id, /^node-[0-9a-f-]{36}$/);
    assert.equal(node.runtimeUuid, sessionId);
    assert.equal(node.tmuxTarget, "");
    assert.equal(node.cwd, "/workspace/desktop");
    assert.equal(node.title, "First objective");
    assert.equal(node.summary, "");
    assert.equal(node.status, "active");
    assert.equal(node.class, "worker");
    assert.deepEqual(node.domains, []);
    assert.equal(node.domainsExplicit, false);

    const summarized = await run(state, ["summary", "--id", node.id, "--summary", "One compact label", "--status", "waiting", "--json"], environment);
    assert.equal(summarized.code, 0, summarized.stderr);
    const repeated = await run(state, ["adopt", "--agent", "codex", "--runtime-uuid", sessionId.toUpperCase(), "--class", "worker", "--json"], domainEnvironment);
    assert.equal(repeated.code, 0, repeated.stderr);
    const repeatedNode = JSON.parse(repeated.stdout).node;
    assert.equal(repeatedNode.id, node.id);
    assert.equal(repeatedNode.summary, "One compact label");
    assert.equal(repeatedNode.status, "waiting");
    assert.deepEqual(repeatedNode.domains, ["desktop"]);
    assert.equal(repeatedNode.domainsExplicit, false);

    const explicit = await run(state, ["adopt", "--agent", "codex", "--runtime-uuid", sessionId, "--class", "worker", "--domains", "manual", "--json"], domainEnvironment);
    assert.equal(explicit.code, 0, explicit.stderr);
    assert.deepEqual(JSON.parse(explicit.stdout).node.domains, ["manual"]);
    assert.equal(JSON.parse(explicit.stdout).node.domainsExplicit, true);
    const preserved = await run(state, ["adopt", "--agent", "codex", "--runtime-uuid", sessionId, "--class", "worker", "--json"], domainEnvironment);
    assert.equal(preserved.code, 0, preserved.stderr);
    assert.deepEqual(JSON.parse(preserved.stdout).node.domains, ["manual"]);
    assert.equal(JSON.parse(preserved.stdout).node.domainsExplicit, true);

    const graph = JSON.parse((await run(state, ["show", "--json"], environment)).stdout);
    assert.equal(graph.nodes.length, 1);
    assert.equal((await readFile(join(state, "events.jsonl"), "utf8")).trim().split("\n").length, 4);

    const claudeDirectory = join(transcripts, "claude", "project");
    await mkdir(claudeDirectory, { recursive: true });
    await writeFile(join(claudeDirectory, `${claudeId}.jsonl`), JSON.stringify({ type: "user", cwd: "/workspace/desktop", message: { content: "Claude objective" } }) + "\n");
    const claude = await run(state, ["adopt", "--agent", "claude", "--runtime-uuid", claudeId, "--class", "observer", "--json"], { ...environment, CLAUDE_SESSION_ROOT: join(transcripts, "claude") });
    assert.equal(claude.code, 0, claude.stderr);
    assert.equal(JSON.parse(claude.stdout).node.runtimeUuid, claudeId);
  } finally {
    await rm(state, { recursive: true, force: true });
    await rm(transcripts, { recursive: true, force: true });
  }
});

test("mesh-graph claims one primary orchestrator per domain and requires explicit takeover", async () => {
  const state = await mkdtemp(join(tmpdir(), "mesh-graph-claim-"));
  try {
    const first = JSON.parse((await run(state, ["add", "--agent", "codex", "--tmux-target", "first", "--json"])).stdout).node;
    const second = JSON.parse((await run(state, ["add", "--agent", "codex", "--tmux-target", "second", "--json"])).stdout).node;
    const claimed = await run(state, ["claim", "--id", first.id, "--role", "orchestrator", "--domain", "alpha", "--json"]);
    assert.equal(claimed.code, 0, claimed.stderr);
    const conflict = await run(state, ["claim", "--id", second.id, "--role", "orchestrator", "--domain", "alpha"]);
    assert.equal(conflict.code, 2);
    assert.match(conflict.stderr, new RegExp(first.id));
    const takeover = await run(state, ["claim", "--id", second.id, "--role", "orchestrator", "--domain", "alpha", "--take-over", first.id, "--json"]);
    assert.equal(takeover.code, 0, takeover.stderr);
    const result = JSON.parse(takeover.stdout);
    assert.equal(result.predecessor.id, first.id);
    const graph = JSON.parse((await run(state, ["show", "--json"])).stdout);
    assert.deepEqual(graph.nodes.find((node) => node.id === first.id).primaryDomains, []);
    assert.deepEqual(graph.nodes.find((node) => node.id === second.id).primaryDomains, ["alpha"]);
  } finally { await rm(state, { recursive: true, force: true }); }
});

test("mesh-graph adds and removes opaque refs without arbitrating duplicate holders", async () => {
  const state = await mkdtemp(join(tmpdir(), "mesh-graph-refs-"));
  const firstUuid = "11111111-1111-4111-8111-111111111111";
  const secondUuid = "22222222-2222-4222-8222-222222222222";
  const opaqueRef = "agentwheel-resource:0123456789abcdef";
  try {
    const first = JSON.parse((await run(state, [
      "add", "--agent", "codex", "--tmux-target", "first", "--runtime-uuid", firstUuid, "--json",
    ])).stdout).node;
    const second = JSON.parse((await run(state, [
      "add", "--agent", "claude", "--tmux-target", "second", "--runtime-uuid", secondUuid, "--json",
    ])).stdout).node;

    const addedById = await run(state, ["ref", "add", "--id", first.id, "--ref", opaqueRef, "--json"]);
    assert.equal(addedById.code, 0, addedById.stderr);
    assert.equal(JSON.parse(addedById.stdout).changed, true);
    assert.deepEqual(JSON.parse(addedById.stdout).node.refs, [opaqueRef]);

    const addedByRuntime = await run(state, ["ref", "add", "--runtime-uuid", secondUuid.toUpperCase(), "--ref", opaqueRef, "--json"]);
    assert.equal(addedByRuntime.code, 0, addedByRuntime.stderr);
    assert.equal(JSON.parse(addedByRuntime.stdout).node.id, second.id);
    const duplicateGraph = JSON.parse((await run(state, ["show", "--json"])).stdout);
    assert.equal(duplicateGraph.nodes.filter((node) => node.refs.includes(opaqueRef)).length, 2);

    const repeatedAdd = await run(state, ["ref", "add", "--id", first.id, "--ref", opaqueRef, "--json"]);
    assert.equal(repeatedAdd.code, 0, repeatedAdd.stderr);
    assert.equal(JSON.parse(repeatedAdd.stdout).changed, false);
    assert.equal((await readFile(join(state, "events.jsonl"), "utf8")).trim().split("\n").length, 4);

    const removedByRuntime = await run(state, ["ref", "remove", "--runtime-uuid", secondUuid, "--ref", opaqueRef, "--json"]);
    assert.equal(removedByRuntime.code, 0, removedByRuntime.stderr);
    assert.equal(JSON.parse(removedByRuntime.stdout).changed, true);
    assert.deepEqual(JSON.parse(removedByRuntime.stdout).node.refs, []);
    const repeatedRemove = await run(state, ["ref", "remove", "--runtime-uuid", secondUuid, "--ref", opaqueRef, "--json"]);
    assert.equal(repeatedRemove.code, 0, repeatedRemove.stderr);
    assert.equal(JSON.parse(repeatedRemove.stdout).changed, false);
    assert.equal((await readFile(join(state, "events.jsonl"), "utf8")).trim().split("\n").length, 5);

    const missingSelector = await run(state, ["ref", "add", "--ref", opaqueRef]);
    assert.equal(missingSelector.code, 2);
    assert.match(missingSelector.stderr, /select exactly one node/);
    const ambiguousSelector = await run(state, ["ref", "add", "--id", first.id, "--runtime-uuid", firstUuid, "--ref", opaqueRef]);
    assert.equal(ambiguousSelector.code, 2);
    assert.match(ambiguousSelector.stderr, /select exactly one node/);
    const invalidRef = await run(state, ["ref", "add", "--id", first.id, "--ref", "private path"]);
    assert.equal(invalidRef.code, 2);
    assert.match(invalidRef.stderr, /invalid opaque ref/);
    assert.equal((await readFile(join(state, "events.jsonl"), "utf8")).trim().split("\n").length, 5);

    const graph = JSON.parse((await run(state, ["show", "--json"])).stdout);
    assert.deepEqual(graph.nodes.find((node) => node.id === first.id).refs, [opaqueRef]);
    assert.deepEqual(graph.nodes.find((node) => node.id === second.id).refs, []);

    const duplicateRuntime = await run(state, [
      "add", "--agent", "bash", "--tmux-target", "duplicate-runtime", "--runtime-uuid", firstUuid, "--json",
    ]);
    assert.equal(duplicateRuntime.code, 0, duplicateRuntime.stderr);
    const ambiguousRuntime = await run(state, ["ref", "add", "--runtime-uuid", firstUuid, "--ref", "source:second"]);
    assert.equal(ambiguousRuntime.code, 2);
    assert.match(ambiguousRuntime.stderr, /runtime UUID matches multiple nodes/);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test("mesh-graph rejects invalid graph inputs without creating state", async () => {
  const state = join(tmpdir(), `mesh-graph-invalid-${process.pid}-${Date.now()}`);
  try {
    const missing = await run(state, ["add", "--agent", "codex"]);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /--tmux-target is required/);

    const invalidStatus = await run(state, ["add", "--agent", "codex", "--tmux-target", "mesh-codex-main", "--status", "online"]);
    assert.equal(invalidStatus.code, 2);
    assert.match(invalidStatus.stderr, /--status must be one of/);

    const invalidRef = await run(state, ["add", "--agent", "codex", "--tmux-target", "mesh-codex-main", "--refs", "prose with spaces"]);
    assert.equal(invalidRef.code, 2);
    assert.match(invalidRef.stderr, /invalid opaque ref/);
    const invalidRefUpdate = await run(state, ["ref", "add", "--id", "node-fixture", "--ref", "private path"]);
    assert.equal(invalidRefUpdate.code, 2);
    assert.match(invalidRefUpdate.stderr, /invalid opaque ref/);
    await assert.rejects(access(join(state, "events.jsonl")));

    const shown = await run(state, ["show", "--json"]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.deepEqual(JSON.parse(shown.stdout).nodes, []);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test("mesh-graph purge removes only named fixture nodes from its derived projection", async () => {
  const state = await mkdtemp(join(tmpdir(), "mesh-graph-purge-"));
  try {
    const real = JSON.parse((await run(state, ["add", "--agent", "codex", "--tmux-target", "real", "--summary", "real", "--json"])).stdout).node;
    const fixture = JSON.parse((await run(state, ["add", "--agent", "bash", "--tmux-target", "fixture", "--summary", "fixture", "--json"])).stdout).node;
    const purged = await run(state, ["purge", "--id", fixture.id, "--json"]);
    assert.equal(purged.code, 0, purged.stderr);
    const graph = JSON.parse((await run(state, ["show", "--json"])).stdout);
    assert.deepEqual(graph.nodes.map((node) => node.id), [real.id]);
    assert.match(await readFile(join(state, "events.jsonl"), "utf8"), /node\.purged/);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});
