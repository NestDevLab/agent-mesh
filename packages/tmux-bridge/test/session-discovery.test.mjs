import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, symlink, utimes, writeFile } from "node:fs/promises";
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

test("Claude writer status resolves a Desktop owner from the supported agents inventory", async () => {
  const home = await mkdtemp(join(tmpdir(), "mesh-claude-writer-inventory-"));
  const procRoot = join(home, "proc");
  const id = "77777777-7777-4777-8777-777777777777";
  const pid = 7331;
  await mkdir(join(procRoot, String(pid)), { recursive: true });
  await writeFile(
    join(procRoot, String(pid), "cmdline"),
    `/tmp/.claude/remote/ccd-cli/2.1.255\0--output-format\0stream-json\0`,
  );
  const claude = join(home, "claude");
  await writeFile(claude, `#!/bin/sh
printf '[{"pid":${pid},"kind":"interactive","sessionId":"${id}","name":"Desktop session"}]\\n'
`);
  await chmod(claude, 0o755);

  const status = await run(home, ["--agent", "claude", "writer-status", id, "--json"], {
    AGENT_WRITER_PROC_ROOT: procRoot,
    CLAUDE_BIN: claude,
  });
  assert.equal(status.code, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout), {
    agent: "claude",
    sessionId: id,
    state: "owned",
    writers: [{ pid, kind: "claude-desktop", source: "claude-agents" }],
    discovery: { complete: true, source: "claude-agents" },
  });
});

test("Claude resume refuses an inventory-owned Desktop session before creating tmux state", async () => {
  const home = await mkdtemp(join(tmpdir(), "mesh-claude-resume-owner-"));
  const procRoot = join(home, "proc");
  const agentsDir = join(home, "agents");
  const binDir = join(home, "bin");
  const id = "88888888-8888-4888-8888-888888888888";
  const pid = 8441;
  await mkdir(join(procRoot, String(pid)), { recursive: true });
  await mkdir(agentsDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(
    join(procRoot, String(pid), "cmdline"),
    `/tmp/.claude/remote/ccd-cli/2.1.255\0--output-format\0stream-json\0`,
  );
  const claude = join(binDir, "claude");
  await writeFile(claude, `#!/bin/sh
printf '[{"pid":${pid},"kind":"interactive","sessionId":"${id}"}]\\n'
`);
  await chmod(claude, 0o755);
  const tmuxLog = join(home, "tmux.log");
  const tmux = join(binDir, "tmux");
  await writeFile(tmux, `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_LOG"
case "$*" in *has-session*) exit 1;; esac
exit 0
`);
  await chmod(tmux, 0o755);
  await writeFile(join(agentsDir, "claude.conf"), `
AGENT_PROMPT_CHAR="❯"
AGENT_WORKING_PATTERN="working"
AGENT_IDLE_PATTERN="idle"
AGENT_RESUME_CMD="claude --resume {SESSION_ID}"
AGENT_NEW_CMD="claude"
AGENT_HAS_CWD_PICKER="false"
AGENT_SESSION_DIR="${home}/sessions"
AGENT_SESSION_CWD_EXTRACTOR='printf cwd'
AGENT_REQUIRE_FREE_SESSION_WRITER="true"
AGENT_SUPPORTS_MODEL="false"
AGENT_MODEL_ARGS=()
AGENT_SUPPORTS_EFFORT="false"
AGENT_EFFORT_ARGS=()
`);
  await writeFile(tmuxLog, "");

  const resumed = await run(home, ["--agent", "claude", "resume", id, "owned-desktop"], {
    AGENT_MESH_AGENTS_DIR: agentsDir,
    AGENT_WRITER_PROC_ROOT: procRoot,
    CLAUDE_BIN: claude,
    PATH: `${binDir}:${process.env.PATH}`,
    TMUX_LOG: tmuxLog,
    MESH_TMUX_SOCKET: "mesh-owned-test",
  });
  assert.equal(resumed.code, 4, resumed.stderr);
  assert.match(resumed.stderr, /already has writer/);
  assert.doesNotMatch(await readFile(tmuxLog, "utf8"), /new-session/);
});

test("Claude writer status reports unknown instead of free when inventory fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "mesh-claude-writer-unknown-"));
  const procRoot = join(home, "proc");
  await mkdir(procRoot, { recursive: true });
  const claude = join(home, "claude");
  await writeFile(claude, "#!/bin/sh\nexit 1\n");
  await chmod(claude, 0o755);

  const status = await run(home, [
    "--agent", "claude", "writer-status", "99999999-9999-4999-8999-999999999999", "--json",
  ], { AGENT_WRITER_PROC_ROOT: procRoot, CLAUDE_BIN: claude });
  assert.equal(status.code, 5, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout), {
    agent: "claude",
    sessionId: "99999999-9999-4999-8999-999999999999",
    state: "unknown",
    writers: [],
    discovery: {
      complete: false,
      source: "claude-agents",
      issues: ["claude_agents_unavailable"],
    },
  });
});

test("session discovery returns an empty page when the provider store does not exist", async () => {
  const home = await mkdtemp(join(tmpdir(), "mesh-empty-discovery-"));
  const listed = await run(home, ["--agent", "codex", "list", "--json"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout), { agent_type: "codex", sessions: [] });
});
