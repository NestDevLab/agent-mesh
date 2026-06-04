const DISCORD_ID_PATTERN = /(?<!\d)\d{17,20}(?!\d)/;
const DISCORD_MENTION_PATTERN = /<@!?\d{17,20}>|<#\d{17,20}>|<@&\d{17,20}>/;
const LOCAL_HOST_PATH_PATTERN = /(?:^|[\s"'=:(])(?:\/[A-Za-z0-9._-]+){2,}/;
const WINDOWS_HOST_PATH_PATTERN = /[A-Za-z]:\\(?:[^\\\s]+\\)+[^\\\s]*/;
const SECRET_LIKE_KEY_PATTERN = /(?:secret|token|credential|password|api[_-]?key|private[_-]?key|mcp[_-]?server)/i;

const DEFAULT_REQUIRED_FIXTURE_CLASSES = [
  "core-neutral",
  "sensitive-business-domain-boundary",
  "client-project-boundary",
  "private-assistant-boundary",
  "development-agent-boundary",
  "staff-community-boundary"
];

export function validateManifestBoundaryFixture(input) {
  const issues = [];
  if (!isRecord(input)) {
    return fail([{ path: "$", message: "must be an object" }]);
  }

  const owner = requireString(input, "owner", issues);
  const boundary_class = requireString(input, "boundary_class", issues);
  const threat = requireString(input, "threat", issues);
  const surfaces = requireStringArray(input, "surfaces", issues);
  const data_boundary = validateDataBoundary(input.data_boundary, issues);
  const egress_policy = requireString(input, "egress_policy", issues);
  const expected_result = requireString(input, "expected_result", issues);
  const negative_cases = validateNegativeCases(input.negative_cases, issues);

  if (issues.length) return fail(issues);

  return ok({
    owner,
    boundary_class,
    threat,
    surfaces,
    data_boundary,
    egress_policy,
    expected_result,
    negative_cases
  });
}

export function validateRequiredFixtureClasses(fixtures, requiredClasses = DEFAULT_REQUIRED_FIXTURE_CLASSES) {
  const issues = [];
  if (!Array.isArray(fixtures)) {
    return fail([{ path: "$", code: "invalid_fixture_collection", message: "must be an array of fixtures" }]);
  }

  const classes = new Set();
  fixtures.forEach((fixture, index) => {
    const result = validateManifestBoundaryFixture(fixture);
    if (!result.ok) {
      for (const issue of result.issues) {
        issues.push({ ...issue, path: `fixtures[${index}].${issue.path}`, code: "invalid_boundary_fixture", boundary_class: safeBoundaryClass(fixture) });
      }
      return;
    }
    classes.add(result.value.boundary_class);
  });

  for (const requiredClass of requiredClasses) {
    if (!classes.has(requiredClass)) {
      issues.push({ path: "$", code: "missing_required_fixture_class", boundary_class: requiredClass, message: `missing required fixture class ${requiredClass}` });
    }
  }

  if (issues.length) return fail(issues);
  return ok({ requiredClasses, foundClasses: [...classes].sort() });
}

export function runManifestBoundaryFixture(fixtureInput, artifact) {
  const fixtureResult = validateManifestBoundaryFixture(fixtureInput);
  if (!fixtureResult.ok) {
    return fail(
      fixtureResult.issues.map((issue) => ({
        ...issue,
        code: "invalid_boundary_fixture",
        boundary_class: safeBoundaryClass(fixtureInput)
      }))
    );
  }

  const fixture = fixtureResult.value;
  const findings = scanForBoundaryViolations(artifact);
  if (findings.length === 0) return ok({ boundary_class: fixture.boundary_class });

  return fail(
    findings.map((finding) => ({
      path: finding.path,
      code: "privacy_boundary_violation",
      boundary_class: fixture.boundary_class,
      message: `${fixture.boundary_class} rejected ${finding.kind} at ${finding.path}`
    }))
  );
}

export function scanForBoundaryViolations(value, basePath = "$") {
  const findings = [];
  walkJsonLike(value, basePath, (path, node, key) => {
    if (typeof node !== "string") return;

    if (DISCORD_MENTION_PATTERN.test(node)) {
      findings.push({ path, kind: "discord_id" });
      return;
    }
    if (DISCORD_ID_PATTERN.test(node)) {
      findings.push({ path, kind: "discord_id" });
      return;
    }
    if (LOCAL_HOST_PATH_PATTERN.test(node) || WINDOWS_HOST_PATH_PATTERN.test(node)) {
      findings.push({ path, kind: "local_host_path" });
      return;
    }
    if (SECRET_LIKE_KEY_PATTERN.test(String(key ?? "")) || SECRET_LIKE_KEY_PATTERN.test(node)) {
      findings.push({ path, kind: "secret_or_live_operation_identifier" });
    }
  });
  return findings;
}

function validateDataBoundary(value, issues) {
  if (!isRecord(value)) {
    issues.push({ path: "data_boundary", message: "must be an object" });
    return undefined;
  }
  const forbidden = requireStringArray(value, "forbidden", issues, "data_boundary.forbidden");
  return { forbidden };
}

function validateNegativeCases(value, issues) {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ path: "negative_cases", message: "must be a non-empty array" });
    return undefined;
  }

  const cases = [];
  for (const [index, item] of value.entries()) {
    const path = `negative_cases[${index}]`;
    if (!isRecord(item)) {
      issues.push({ path, message: "must be an object" });
      continue;
    }
    const id = requireString(item, "id", issues, `${path}.id`);
    const surface = requireString(item, "surface", issues, `${path}.surface`);
    const failure_mode = requireString(item, "failure_mode", issues, `${path}.failure_mode`);
    const expected = requireString(item, "expected", issues, `${path}.expected`);
    cases.push({ id, surface, failure_mode, expected });
  }
  return cases;
}

function requireString(input, key, issues, path = key) {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    issues.push({ path, message: "must be a non-empty string" });
    return undefined;
  }
  return value;
}

function requireStringArray(input, key, issues, path = key) {
  const value = input[key];
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string" && item.length > 0)) {
    issues.push({ path, message: "must be a non-empty array of non-empty strings" });
    return undefined;
  }
  return value;
}

function walkJsonLike(value, path, visit, key) {
  visit(path, value, key);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkJsonLike(item, `${path}[${index}]`, visit, index));
    return;
  }
  if (isRecord(value)) {
    for (const [childKey, childValue] of Object.entries(value)) {
      walkJsonLike(childValue, path === "$" ? childKey : `${path}.${childKey}`, visit, childKey);
    }
  }
}

function safeBoundaryClass(value) {
  return isRecord(value) && typeof value.boundary_class === "string" ? value.boundary_class : "unknown";
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ok(value) {
  return { ok: true, value, issues: [] };
}

function fail(issues) {
  return { ok: false, issues };
}
