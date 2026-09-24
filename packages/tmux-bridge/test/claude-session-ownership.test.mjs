import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectClaudeSessionOwnership } from "../bin/claude-session-ownership.mjs";

const SESSION = "22222222-2222-4222-8222-222222222222";

test("a Claude CLI launched with --session-id owns that session", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-claude-ownership-"));
  try {
    const proc = join(root, "proc");
    const argvs = {
      200: ["claude", "--session-id", SESSION],
      201: ["claude", `--session-id=${SESSION}`],
      202: ["claude", "--session-id", "33333333-3333-4333-8333-333333333333"],
      203: ["node", "--session-id", SESSION]
    };
    for (const [pid, argv] of Object.entries(argvs)) {
      mkdirSync(join(proc, pid), { recursive: true });
      writeFileSync(join(proc, pid, "cmdline"), `${argv.join("\0")}\0`);
    }
    const claudeBin = join(root, "claude");
    writeFileSync(claudeBin, "#!/bin/sh\necho '[]'\n");
    chmodSync(claudeBin, 0o755);

    const ownership = inspectClaudeSessionOwnership(SESSION, { procRoot: proc, claudeBin });
    assert.equal(ownership.state, "owned");
    assert.equal(ownership.discovery.complete, true);
    assert.deepEqual(ownership.writers.map((writer) => [writer.pid, writer.kind]), [
      [200, "claude-cli"],
      [201, "claude-cli"]
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
