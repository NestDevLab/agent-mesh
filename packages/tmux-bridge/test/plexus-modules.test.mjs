import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
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

test("describe verifies identity and enforces timeouts", async () => {
  const good = "process.stdout.write(JSON.stringify({schema:'agent-mesh.plexus-module.v1',name:'example',namespace:'example',operations:['describe']}))";
  const entry = { name: "example", command: [process.execPath, "-e", good], timeoutMs: 1000 };
  assert.equal((await describeModule(entry)).namespace, "example");
  await assert.rejects(describeModule({ ...entry, name: "other" }), /description/);
  await assert.rejects(describeModule({ ...entry, command: [process.execPath, "-e", "setTimeout(()=>{}, 10000)"], timeoutMs: 20 }), /timed out/);
});
