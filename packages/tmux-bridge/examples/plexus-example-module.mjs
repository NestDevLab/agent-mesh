#!/usr/bin/env node
// Synthetic protocol example; it has no access to real graph state.
if (process.argv[2] !== "describe") {
  process.stderr.write("unsupported operation\n");
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({
    schema: "agent-mesh.plexus-module.v1",
    name: "example",
    namespace: "example",
    operations: ["describe"],
  }) + "\n");
}
