import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
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
