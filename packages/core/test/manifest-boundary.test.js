import assert from "node:assert/strict";
import test from "node:test";

import {
  runManifestBoundaryFixture,
  validateManifestBoundaryFixture,
  validateRequiredFixtureClasses
} from "../src/manifest.js";

const minimumFixture = {
  owner: "example-domain",
  boundary_class: "example-boundary",
  threat: "private operational context leaking into publishable manifest artifacts",
  surfaces: ["manifest fixture export", "validator error output", "CI logs"],
  data_boundary: {
    forbidden: [
      "customer/staff personal context",
      "private operational memory",
      "numeric platform IDs",
      "local host paths",
      "server names or credentials tied to live operations"
    ]
  },
  egress_policy: "no private data may appear in repo fixtures, generated manifests, validator snapshots, or CI output",
  expected_result: "fail validation with deterministic privacy-boundary error",
  negative_cases: [
    {
      id: "private-memory-egress",
      surface: "manifest fixture export",
      failure_mode: "fixture includes private operational memory or identifying runtime metadata",
      expected: "validator rejects; output references field/path and boundary class, without echoing the private value"
    }
  ]
};

test("validates the minimum manifest boundary fixture schema", () => {
  const result = validateManifestBoundaryFixture(minimumFixture);

  assert.equal(result.ok, true);
  assert.equal(result.value.boundary_class, "example-boundary");
  assert.equal(result.value.negative_cases[0].id, "private-memory-egress");
});

test("requires deterministic negative cases", () => {
  const result = validateManifestBoundaryFixture({
    ...minimumFixture,
    negative_cases: []
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map((issue) => issue.path), ["negative_cases"]);
});

test("requires every negative case field", () => {
  const result = validateManifestBoundaryFixture({
    ...minimumFixture,
    negative_cases: [{ id: "missing-fields", surface: "generated_config", expected: "fail" }]
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map((issue) => issue.path), ["negative_cases[0].failure_mode"]);
});

test("rejects private identifiers without echoing private values", () => {
  const numericId = "1".repeat(18);
  const hostPath = `/${["private", "workspace", "customer-prod"].join("/")}`;
  const credentialValue = ["live", "credential"].join("-");
  const artifact = {
    manifest: {
      owner: "example-domain",
      operational_note: `deploy from ${hostPath}`,
      channel: numericId,
      mention: `<@${numericId}>`,
      credential: credentialValue
    }
  };

  const result = runManifestBoundaryFixture(minimumFixture, artifact);

  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, "privacy_boundary_violation");
  assert.equal(result.issues[0].boundary_class, "example-boundary");
  assert.match(result.issues.map((issue) => issue.path).join("\n"), /manifest\.operational_note/);
  assert.match(result.issues.map((issue) => issue.path).join("\n"), /manifest\.channel/);
  assert.match(result.issues.map((issue) => issue.path).join("\n"), /manifest\.mention/);
  assert.match(result.issues.map((issue) => issue.path).join("\n"), /manifest\.credential/);
  assert.doesNotMatch(JSON.stringify(result), /customer-prod/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(numericId));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(credentialValue));
});

test("accepts runtime-neutral artifacts with no boundary findings", () => {
  const result = runManifestBoundaryFixture(minimumFixture, {
    schema: "agent-manifest/v0",
    owner: "example-domain",
    manifest: {
      capabilities: ["handoff", "validation"],
      transport: "runtime-neutral"
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test("requires the public Sprint 0 fixture classes", () => {
  const fixtures = [
    { ...minimumFixture, boundary_class: "core-neutral" },
    { ...minimumFixture, boundary_class: "sensitive-business-domain-boundary" },
    { ...minimumFixture, boundary_class: "client-project-boundary" },
    { ...minimumFixture, boundary_class: "private-assistant-boundary" },
    { ...minimumFixture, boundary_class: "development-agent-boundary" },
    { ...minimumFixture, boundary_class: "staff-community-boundary" }
  ];

  const result = validateRequiredFixtureClasses(fixtures);

  assert.equal(result.ok, true);
  assert.deepEqual(result.value.requiredClasses, [
    "core-neutral",
    "sensitive-business-domain-boundary",
    "client-project-boundary",
    "private-assistant-boundary",
    "development-agent-boundary",
    "staff-community-boundary"
  ]);
});

test("fails closed when a required fixture class is absent", () => {
  const result = validateRequiredFixtureClasses([{ ...minimumFixture, boundary_class: "core-neutral" }]);

  assert.equal(result.ok, false);
  assert.equal(result.issues.some((issue) => issue.boundary_class === "staff-community-boundary"), true);
});
