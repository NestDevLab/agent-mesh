#!/usr/bin/env node
// Synthetic protocol example; it never writes attributes or events.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

if (process.argv[2] === "process") {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const batchId = createHash("sha256").update(JSON.stringify(input.cursor)).digest("hex");
  process.stdout.write(JSON.stringify({ schema: "agent-mesh.plexus-module.v1", name: "example", batchId, attributes: [], events: [] }) + "\n");
} else if (process.argv[2] !== "describe") {
  process.stderr.write("unsupported operation\n");
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({
    schema: "agent-mesh.plexus-module.v1",
    name: "example",
    namespace: "example",
    operations: ["describe", "process"],
  }) + "\n");
}
