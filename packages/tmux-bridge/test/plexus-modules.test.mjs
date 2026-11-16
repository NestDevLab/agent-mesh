import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readModuleRegistry, describeModule } from "../bin/plexus-modules.mjs";

test("registry is private configuration and duplicate names fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plexus-modules-"));
  try {
    const file = join(dir, "config.json");
    assert.deepEqual(await readModuleRegistry(file), []);
    const entry = { name: "example", command: [process.execPath, "fixture.mjs"] };
    await writeFile(file, JSON.stringify({ schemaVersion: 1, modules: [entry, entry] }));
    await assert.rejects(readModuleRegistry(file), /duplicate/);
    await writeFile(file, "{");
    await assert.rejects(readModuleRegistry(file));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("graph discovers and describes only registered modules", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plexus-modules-cli-"));
  try {
    const config = join(dir, "config.json");
    const fixture = fileURLToPath(new URL("../examples/plexus-example-module.mjs", import.meta.url));
    const graph = fileURLToPath(new URL("../bin/mesh-graph.mjs", import.meta.url));
    await writeFile(config, JSON.stringify({ schemaVersion: 1, modules: [{ name: "example", command: [process.execPath, fixture] }] }));
    const exec = promisify(execFile);
    const list = await exec(process.execPath, [graph, "module", "list", "--config", config]);
    assert.deepEqual(JSON.parse(list.stdout), { modules: [{ name: "example" }] });
    const describe = await exec(process.execPath, [graph, "module", "describe", "--config", config, "--name", "example"]);
    assert.equal(JSON.parse(describe.stdout).namespace, "example");
    await assert.rejects(exec(process.execPath, [graph, "module", "describe", "--config", config, "--name", "unknown"]));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("describe verifies identity and enforces timeouts", async () => {
  const good = "process.stdout.write(JSON.stringify({schema:'agent-mesh.plexus-module.v1',name:'example',namespace:'example',operations:['describe']}))";
  const entry = { name: "example", command: [process.execPath, "-e", good], timeoutMs: 1000 };
  assert.equal((await describeModule(entry)).namespace, "example");
  await assert.rejects(describeModule({ ...entry, name: "other" }), /invalid module response/);
  await assert.rejects(describeModule({ ...entry, command: [process.execPath, "-e", "setTimeout(()=>{}, 10000)"], timeoutMs: 20 }), /timed out/);
});
