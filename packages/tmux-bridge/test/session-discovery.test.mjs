import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(packageRoot, "bin", "agent-session.sh");

async function run(home, args, extraEnv = {}) {
  try {
    const result = await exec(script, args, {
      env: { ...process.env, HOME: home, CODEX_NO_REMOTE: "1", ...extraEnv }
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? ""
    };
  }
}

test("Codex session list and inspect expose stable JSON metadata", async () => {
  const home = await mkdtemp(join(tmpdir(), "mesh-session-discovery-"));
  const dir = join(home, ".codex", "sessions", "2026", "08", "30");
  await mkdir(dir, { recursive: true });
  const newestId = "11111111-1111-4111-8111-111111111111";
  const oldestId = "22222222-2222-4222-8222-222222222222";
  const newest = join(dir, `rollout-${newestId}.jsonl`);
  const oldest = join(dir, `rollout-${oldestId}.jsonl`);
  await writeFile(newest, JSON.stringify({ type: "session_meta", payload: { cwd: "/workspace/new" } }) + "\n");
  await writeFile(oldest, JSON.stringify({ type: "session_meta", payload: { cwd: "/workspace/old" } }) + "\n");
  await utimes(oldest, new Date("2026-08-29T00:00:00Z"), new Date("2026-08-29T00:00:00Z"));
  await utimes(newest, new Date("2026-08-30T00:00:00Z"), new Date("2026-08-30T00:00:00Z"));

  const listed = await run(home, ["--agent", "codex", "list", "--json", "--limit", "1"]);
  assert.equal(listed.code, 0, listed.stderr);
  const payload = JSON.parse(listed.stdout);
  assert.equal(payload.agent_type, "codex");
  assert.deepEqual(payload.sessions.map((session) => session.session_id), [newestId]);
  assert.equal(payload.sessions[0].cwd, "/workspace/new");

  const inspected = await run(home, ["--agent", "codex", "inspect", oldestId, "--json"]);
  assert.equal(inspected.code, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).sessions[0].cwd, "/workspace/old");

  const missing = await run(home, [
    "--agent", "codex", "inspect", "33333333-3333-4333-8333-333333333333", "--json"
  ]);
  assert.equal(missing.code, 3);
});

test("Codex writer status identifies the process that owns the thread lock", async () => {
  const home = await mkdtemp(join(tmpdir(), "mesh-codex-writer-"));
  const procRoot = join(home, "proc");
  const id = "55555555-5555-4555-8555-555555555555";
  const lock = join(home, ".codex", "thread-writer-locks", `${id}.lock`);
  await mkdir(dirname(lock), { recursive: true });
  await writeFile(lock, "");
  await mkdir(join(procRoot, "4242", "fd"), { recursive: true });
  await writeFile(join(procRoot, "4242", "cmdline"), "/usr/local/bin/codex\0app-server\0");
  await symlink(lock, join(procRoot, "4242", "fd", "7"));

  const status = await run(home, ["--agent", "codex", "writer-status", id, "--json"], {
    AGENT_WRITER_PROC_ROOT: procRoot
  });
  assert.equal(status.code, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout), {
    agent: "codex",
    sessionId: id,
    writers: [{ pid: 4242, kind: "codex" }]
  });
});

test("Claude session discovery uses the same provider-neutral JSON contract", async () => {
  const home = await mkdtemp(join(tmpdir(), "mesh-claude-discovery-"));
  const id = "44444444-4444-4444-8444-444444444444";
  const dir = join(home, ".claude", "projects", "-workspace-claude");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.jsonl`), "{}\n");
  const listed = await run(home, ["--agent", "claude", "list", "--json"]);
  assert.equal(listed.code, 0, listed.stderr);
  const payload = JSON.parse(listed.stdout);
  assert.equal(payload.agent_type, "claude");
  assert.equal(payload.sessions[0].session_id, id);
  assert.match(payload.sessions[0].cwd, /workspace\/claude$/);
});

test("session discovery returns an empty page when the provider store does not exist", async () => {
  const home = await mkdtemp(join(tmpdir(), "mesh-empty-discovery-"));
  const listed = await run(home, ["--agent", "codex", "list", "--json"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout), { agent_type: "codex", sessions: [] });
});
