#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "agent-mesh-smoke-"));
const stateFile = path.join(tmp, "state.json");
const fixture = `cc-mesh: karan
cc-mesh-from: claude
cc-mesh-id: smoke-1
cc-mesh-turn: karan
cc-mesh-final: false
cc-mesh-seen: claude
hop-limit: 2

partial one
---mesh-message---
cc-mesh: karan
cc-mesh-from: claude
cc-mesh-id: smoke-1
cc-mesh-turn: karan
cc-mesh-final: true
cc-mesh-seen: claude
hop-limit: 2

final two
---mesh-message---
cc-mesh: karan
cc-mesh-from: claude
cc-mesh-id: smoke-1
cc-mesh-turn: karan
cc-mesh-final: true
cc-mesh-seen: claude
hop-limit: 2

final duplicate
---mesh-message---
cc-mesh: karan
cc-mesh-from: claude
cc-mesh-id: smoke-2
cc-mesh-turn: nestdev
cc-mesh-final: true

wrong turn
---mesh-message---
cc-mesh: karan
cc-mesh-from: claude
cc-mesh-id: smoke-3
cc-mesh-turn: karan
cc-mesh-final: true
cc-mesh-seen: claude,karan

loop`;

try {
  const run = spawnSync(process.execPath, ["scripts/mesh-dispatch-harness.mjs", "--participant", "karan", "--state-file", stateFile], {
    input: fixture,
    encoding: "utf8"
  });
  if (run.status !== 0) throw new Error(run.stderr || `harness exit ${run.status}`);
  const lines = run.stdout.trim().split(/\n+/).map((line) => JSON.parse(line));
  const expected = [
    ["mesh_v1_partial_buffered", "buffer_only"],
    ["mesh_v1_final_dispatch_ready", "dispatch_once"],
    ["mesh_v1_duplicate_suppressed", "none"],
    ["mesh_v1_not_local_turn", "none"],
    ["mesh_v1_loop_guard_seen", "none"]
  ];
  for (const [index, [reason, action]] of expected.entries()) {
    if (lines[index]?.reason !== reason || lines[index]?.nextAction !== action) {
      throw new Error(`unexpected line ${index + 1}: ${JSON.stringify(lines[index])}`);
    }
  }
  if (lines[1].dispatchText !== "partial one\nfinal two") {
    throw new Error(`unexpected assembled dispatch text: ${JSON.stringify(lines[1].dispatchText)}`);
  }
  console.log("PASS mesh dispatch harness smoke");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
