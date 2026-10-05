#!/usr/bin/env node
/** Read-only inventory for a separately approved graph backup and fixture purge. */
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const index = process.argv.indexOf("--state");
if (index < 0 || !process.argv[index + 1]) {
  process.stderr.write("usage: graph-cleanup-dry-run.mjs --state <graph-state-dir>\n");
  process.exit(2);
}
const state = resolve(process.argv[index + 1]);
const graph = JSON.parse(readFileSync(join(state, "graph.json"), "utf8"));
const candidates = graph.nodes.filter((node) =>
  String(node.cwd || "").startsWith("/tmp/agent-mesh-launch-options")
  || String(node.tmuxTarget || "").startsWith("launch-options-"));
const events = join(state, "events.jsonl");
const report = {
  mode: "dry-run",
  backupRequired: true,
  graphNodes: graph.nodes.length,
  fixtureNodes: candidates.map((node) => ({ id: node.id, cwd: node.cwd, tmuxTarget: node.tmuxTarget })),
  eventLogBytes: statSync(events).size,
  nextStepsAfterApproval: ["back up graph state", "verify backup", "purge listed node ids", "compact with 30-day retention", "verify graph"],
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
