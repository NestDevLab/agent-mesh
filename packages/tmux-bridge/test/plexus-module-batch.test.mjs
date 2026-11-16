import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const graph = fileURLToPath(new URL("../bin/mesh-graph.mjs", import.meta.url));
const uuid = "22222222-2222-4222-8222-222222222222";
const session = `codex:${uuid}`;

test("module batches atomically update their own state and survive replay and compaction", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "plexus-batch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, "state"), config = join(dir, "modules.json");
  await writeFile(config, JSON.stringify({ schemaVersion: 1, modules: [{ name: "example", command: ["example"] }, { name: "other", command: ["example"] }] }));
  const call = async (...args) => JSON.parse((await exec(process.execPath, [graph, "--state", state, ...args])).stdout);
  await call("add", "--agent", "codex", "--tmux-target", "test", "--cwd", "/synthetic", "--runtime-uuid", uuid, "--json");
  await call("migrate", "--apply", "--json");
  const start = await call("query", "changes", "--input", JSON.stringify({ initial: "head" }));
  const batch = { id: "a1", cursor: null, nextCursor: "one", attributes: [{ session, key: "count", value: 1 }], events: [{ type: "example.changed", session, data: { count: 1 } }] };
  const apply = (name, input) => call("module", "apply", "--config", config, "--name", name, "--input", JSON.stringify(input));
  assert.equal((await apply("example", batch)).duplicate, false);
  assert.equal((await apply("example", batch)).duplicate, true);
  await assert.rejects(apply("example", { ...batch, attributes: [] }), /batch id reused/);
  await assert.rejects(apply("other", batch), /namespaced/);
  await assert.rejects(apply("example", { ...batch, id: "a2" }), /cursor conflict/);
  const feed = await call("query", "changes", "--input", JSON.stringify({ sinceCursor: start.cursor }));
  assert.equal(feed.events.filter(item => item.type === "example.changed").length, 1);
  await rm(join(state, "checkpoint.json"));
  let projection = await call("show", "--json");
  assert.equal(projection.nodes[0].moduleAttributes.example.count, 1);
  assert.equal(projection.moduleStates[0].cursor, "one");
  await call("compact", "--all-history", "--apply", "--json");
  await rm(join(state, "checkpoint.json"), { force: true });
  projection = await call("show", "--json");
  assert.equal(projection.nodes[0].moduleAttributes.example.count, 1);
  assert.equal(projection.moduleStates[0].cursor, "one");
  assert.equal((await apply("example", batch)).duplicate, true);
  const racing = await Promise.allSettled([
    apply("example", { id: "race-a", cursor: "one", nextCursor: "two-a", attributes: [], events: [] }),
    apply("example", { id: "race-b", cursor: "one", nextCursor: "two-b", attributes: [], events: [] }),
  ]);
  assert.equal(racing.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(racing.filter(item => item.status === "rejected").length, 1);
});

test("a registered module can initialize once and an idle run does not create events", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "plexus-run-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, "state"), config = join(dir, "modules.json");
  const fixture = fileURLToPath(new URL("../examples/plexus-example-module.mjs", import.meta.url));
  await writeFile(config, JSON.stringify({ schemaVersion: 1, modules: [{ name: "example", command: [process.execPath, fixture] }] }));
  const call = async (...args) => JSON.parse((await exec(process.execPath, [graph, "--state", state, ...args])).stdout);
  await call("add", "--agent", "codex", "--tmux-target", "test", "--cwd", "/synthetic", "--runtime-uuid", uuid, "--json");
  await call("migrate", "--apply", "--json");
  assert.equal((await call("module", "conformance", "--config", config, "--name", "example")).conformance, "pass");
  assert.equal((await call("module", "run", "--config", config, "--name", "example")).duplicate, false);
  const before = await call("show", "--json");
  assert.equal((await call("module", "run", "--config", config, "--name", "example")).unchanged, true);
  const after = await call("show", "--json");
  assert.equal(after.lastSeq, before.lastSeq);
});

test("lifecycle observations are idempotent across replay and compaction", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "plexus-life-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, "state");
  const call = async (...args) => JSON.parse((await exec(process.execPath, [graph, "--state", state, ...args])).stdout);
  await call("add", "--agent", "codex", "--tmux-target", "test", "--cwd", "/synthetic", "--runtime-uuid", uuid, "--json");
  await call("migrate", "--apply", "--json");
  const head = await call("query", "changes", "--input", JSON.stringify({ initial: "head" }));
  const args = ["lifecycle", "record", "--session", session, "--type", "session.idle", "--id", "source-observation-1", "--evidence", "observation:sample"];
  assert.equal((await call(...args)).duplicate, false);
  assert.equal((await call(...args)).duplicate, true);
  await assert.rejects(call(...args.slice(0, -1), "observation:different"), /different contents/);
  const feed = await call("query", "changes", "--input", JSON.stringify({ sinceCursor: head.cursor }));
  assert.equal(feed.events.filter(item => item.type === "session.idle").length, 1);
  await call("compact", "--all-history", "--apply", "--json");
  await rm(join(state, "checkpoint.json"), { force: true });
  assert.equal((await call(...args)).duplicate, true);
});
