import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  runManifestBoundaryFixture,
  validateManifestBoundaryFixture,
  validateRequiredFixtureClasses
} from "../src/manifest.js";

const fixtureDir = path.resolve(import.meta.dirname, "../fixtures/manifest-boundaries");
const entries = (await readdir(fixtureDir)).filter((entry) => entry.endsWith(".json")).sort();
const fixtures = [];
const failures = [];

for (const entry of entries) {
  const fixture = JSON.parse(await readFile(path.join(fixtureDir, entry), "utf8"));
  fixtures.push(fixture);

  const schemaResult = validateManifestBoundaryFixture(fixture);
  if (!schemaResult.ok) {
    failures.push({ file: entry, phase: "schema", issues: schemaResult.issues });
    continue;
  }

  const artifact = fixture.artifact ?? {};
  const runResult = runManifestBoundaryFixture(fixture, artifact);
  if (entry.endsWith(".expected-fail.json")) {
    if (runResult.ok) {
      failures.push({ file: entry, phase: "expected-fail", issues: [{ message: "fixture artifact unexpectedly passed" }] });
    }
  } else if (!runResult.ok) {
    failures.push({ file: entry, phase: "run", issues: runResult.issues });
  }
}

const requiredResult = validateRequiredFixtureClasses(fixtures);
if (!requiredResult.ok) {
  failures.push({ file: "<fixture-set>", phase: "required-classes", issues: requiredResult.issues });
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, fixtures: entries }, null, 2));
}
