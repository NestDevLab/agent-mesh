import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const helper = join(packageRoot, "bin", "codex-resume-options.py");
const sessionId = "66666666-6666-4666-8666-666666666666";

function context(overrides = {}) {
  return {
    cwd: "/workspace/demo",
    model: "gpt-5.6-sol",
    effort: "medium",
    approval_policy: "never",
    sandbox_policy: { type: "read-only" },
    ...overrides
  };
}

async function writeTranscript(root, name, records, mtime) {
  const path = join(root, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  await utimes(path, mtime, mtime);
  return path;
}

async function fixture(payload = context()) {
  const root = await mkdtemp(join(tmpdir(), "codex-resume-options-"));
  const old = new Date("2026-09-08T10:00:00Z");
  const current = new Date("2026-09-08T11:00:00Z");
  const decoy = new Date("2026-09-08T12:00:00Z");
  await writeTranscript(root, `old-${sessionId}.jsonl`, [
    { type: "session_meta", payload: { id: sessionId } },
    { type: "turn_context", payload: context({ model: "stale-model" }) }
  ], old);
  await writeTranscript(root, `current-${sessionId}.jsonl`, [
    { type: "session_meta", payload: { id: sessionId } },
    { type: "turn_context", payload }
  ], current);
  await writeTranscript(root, `decoy-${sessionId}.jsonl`, [
    { type: "session_meta", payload: { id: "77777777-7777-4777-8777-777777777777" } },
    { type: "turn_context", payload: context({ model: "wrong-session" }) }
  ], decoy);
  return root;
}

async function invoke(root) {
  try {
    const result = await exec("python3", [helper, "--session", sessionId, "--root", root]);
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("resume options preserve the latest matching read-only policy", async () => {
  const result = await invoke(await fixture());
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), "-c 'model=\"gpt-5.6-sol\"' -c 'model_reasoning_effort=\"medium\"' -c 'approval_policy=\"never\"' --sandbox read-only --cd /workspace/demo");
});

test("resume options preserve workspace-write roots and network flags", async () => {
  const root = await fixture(context({ sandbox_policy: {
    type: "workspace-write",
    writable_roots: ["/workspace/demo", "/tmp/build cache"],
    network_access: false,
    exclude_tmpdir_env_var: true,
    exclude_slash_tmp: false
  } }));
  const result = await invoke(root);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), "-c 'model=\"gpt-5.6-sol\"' -c 'model_reasoning_effort=\"medium\"' -c 'approval_policy=\"never\"' -c 'sandbox_workspace_write.writable_roots=[\"/workspace/demo\",\"/tmp/build cache\"]' -c sandbox_workspace_write.network_access=false -c sandbox_workspace_write.exclude_tmpdir_env_var=true -c sandbox_workspace_write.exclude_slash_tmp=false --sandbox workspace-write --cd /workspace/demo");
});

test("resume options fail closed for malformed, missing, and unsupported policy", async (t) => {
  const cases = [
    [context({ model: undefined }), /missing or invalid model/],
    [context({ effort: 3 }), /missing or invalid effort/],
    [context({ approval_policy: undefined }), /missing or invalid approval_policy/],
    [context({ cwd: undefined }), /missing or invalid cwd/],
    [context({ sandbox_policy: undefined }), /missing or invalid sandbox_policy/],
    [context({ sandbox_policy: { type: "external-sandbox" } }), /unsupported sandbox_policy/],
    [context({ sandbox_policy: { type: "workspace-write", writable_roots: [3] } }), /invalid sandbox_policy.writable_roots/]
  ];
  for (const [payload, expected] of cases) {
    await t.test(String(expected), async () => {
      const result = await invoke(await fixture(payload));
      assert.equal(result.code, 1);
      assert.match(result.stderr, expected);
      assert.equal(result.stdout, "");
    });
  }

  await t.test("invalid JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-resume-options-invalid-"));
    await writeFile(join(root, `invalid-${sessionId}.jsonl`), `{\"type\":\"session_meta\",\"payload\":{\"id\":\"${sessionId}\"}}\n{broken\n`);
    const result = await invoke(root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /invalid JSON/);
  });
});

for (const effort of ["max", "ultra"]) {
  test(`resume options preserve ${effort} effort`, async () => {
    const result = await invoke(await fixture(context({ effort })));
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes(`model_reasoning_effort="${effort}"`));
  });
}
