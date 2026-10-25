import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(packageRoot, "bin", "agent-session.sh");
const socket = `mesh-resume-guard-${process.pid}`;

async function fixture(id) {
  const home = await mkdtemp(join(tmpdir(), "mesh-resume-guard-"));
  const codex = join(home, ".codex");
  const fakeBin = join(home, "bin");
  await mkdir(fakeBin, { recursive: true });
  // a launch that gets past the guard must never start the real CLI
  await writeFile(join(fakeBin, "codex"), "#!/bin/sh\nexec sleep 30\n");
  await chmod(join(fakeBin, "codex"), 0o755);
  return { home, codex, fakeBin, id };
}

async function writeRollout(dir, id, cwd) {
  await mkdir(dir, { recursive: true });
  const meta = { type: "session_meta", payload: { id, cwd } };
  await writeFile(join(dir, `rollout-2026-01-01T00-00-00-${id}.jsonl`), JSON.stringify(meta) + "\n");
}

function writeThreadsDb(codex, rows) {
  const sql = [
    "CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER, source TEXT, is_pinned INTEGER, thread_section_id TEXT);",
    ...rows.map((row) => `INSERT INTO threads VALUES ('${row.id}', ${row.archived ?? 0}, '${row.source}', ${row.pinned ?? 0}, ${row.section ? `'${row.section}'` : "NULL"});`),
  ].join("\n");
  execFileSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript(sys.argv[2]); c.commit()",
    join(codex, "state_5.sqlite"), sql]);
}

async function fakeWriter(f, argv) {
  const procRoot = join(f.home, "proc");
  const lock = join(f.codex, "thread-writer-locks", `${f.id}.lock`);
  await mkdir(dirname(lock), { recursive: true });
  await writeFile(lock, "");
  await mkdir(join(procRoot, "4242", "fd"), { recursive: true });
  await writeFile(join(procRoot, "4242", "cmdline"), argv.join("\0") + "\0");
  await symlink(lock, join(procRoot, "4242", "fd", "7"));
  return procRoot;
}

async function run(f, args, extraEnv = {}) {
  const env = {
    ...process.env,
    HOME: f.home,
    XDG_CONFIG_HOME: join(f.home, ".config"),
    XDG_STATE_HOME: join(f.home, ".state"),
    PATH: `${f.fakeBin}:${process.env.PATH}`,
    CODEX_NO_REMOTE: "1",
    MESH_TMUX_SOCKET: socket,
    MESH_GRAPH_DISABLE: "1",
    ...extraEnv,
  };
  try {
    const result = await exec(script, args, { env, timeout: 60_000 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

function tmux(...args) {
  try {
    return execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

test.after(() => { tmux("kill-server"); });

test("resume of an archived Codex session names the unarchive command", async () => {
  const f = await fixture("71000000-0000-4000-8000-000000000001");
  await writeRollout(join(f.codex, "archived_sessions"), f.id, f.home);
  const result = await run(f, ["--agent", "codex", "resume", f.id]);
  assert.equal(result.code, 3, result.stderr);
  assert.match(result.stderr, new RegExp(`codex unarchive ${f.id}`));
  assert.equal(tmux("has-session", "-t", `mesh-codex-${f.id.slice(0, 8)}`), null);
});

test("resume of a thread an app-server serves points to codex queue", async () => {
  const f = await fixture("72000000-0000-4000-8000-000000000002");
  await writeRollout(join(f.codex, "sessions", "2026", "01", "01"), f.id, f.home);
  const procRoot = await fakeWriter(f, ["/opt/codex/codex", "app-server", "--listen", "unix://"]);
  const env = { AGENT_WRITER_PROC_ROOT: procRoot };
  const status = await run(f, ["--agent", "codex", "writer-status", f.id, "--json"], env);
  assert.deepEqual(JSON.parse(status.stdout).writers, [{ pid: 4242, kind: "codex", role: "app-server" }]);

  const direct = await run(f, ["--agent", "codex", "resume", f.id], env);
  assert.equal(direct.code, 4, direct.stderr);
  assert.match(direct.stderr, new RegExp(`codex queue --thread ${f.id}`));

  // the governed parent must report the refusal itself, before any Limen dispatch
  const policy = join(f.home, "policy.json");
  await writeFile(policy, "{}\n");
  const governed = await run(f, ["--agent", "codex", "--profile", "developer", "--limen-config", policy, "resume", f.id],
    { ...env, LIMEN_BIN: "/bin/false" });
  assert.equal(governed.code, 4, governed.stderr);
  assert.match(governed.stderr, new RegExp(`codex queue --thread ${f.id}`));
  assert.doesNotMatch(governed.stderr, /Limen governed launch/);
});

test("resume refuses an idle Desktop-visible thread unless explicitly allowed", async () => {
  const f = await fixture("73000000-0000-4000-8000-000000000003");
  await writeRollout(join(f.codex, "sessions", "2026", "01", "01"), f.id, join(f.home, "missing-cwd"));
  writeThreadsDb(f.codex, [{ id: f.id, source: "vscode", section: "section-1" }]);

  const refused = await run(f, ["--agent", "codex", "resume", f.id]);
  assert.equal(refused.code, 6, refused.stderr);
  assert.match(refused.stderr, /visible in Codex Desktop/);
  assert.match(refused.stderr, new RegExp(`codex queue --thread ${f.id}`));
  assert.match(refused.stderr, /--allow-desktop-thread/);
  assert.equal(tmux("has-session", "-t", `mesh-codex-${f.id.slice(0, 8)}`), null);

  // past the guard, the missing recorded cwd stops the launch before tmux
  const allowed = await run(f, ["--agent", "codex", "resume", f.id, "--allow-desktop-thread"]);
  assert.equal(allowed.code, 3, allowed.stderr);
  assert.match(allowed.stderr, /session cwd unavailable/);
  assert.match(allowed.stderr, new RegExp(`release mesh-codex-${f.id.slice(0, 8)} ${f.id}`));
});

test("a CLI-only thread outside Desktop resumes past the guard", async () => {
  const f = await fixture("74000000-0000-4000-8000-000000000004");
  await writeRollout(join(f.codex, "sessions", "2026", "01", "01"), f.id, join(f.home, "missing-cwd"));
  writeThreadsDb(f.codex, [{ id: f.id, source: "cli" }]);
  const result = await run(f, ["--agent", "codex", "resume", f.id]);
  assert.equal(result.code, 3, result.stderr);
  assert.match(result.stderr, /session cwd unavailable/);
  assert.doesNotMatch(result.stderr, /Codex Desktop/);
});

test("release kills the target and proves its CLI writer is gone", async () => {
  const f = await fixture("75000000-0000-4000-8000-000000000005");
  const lock = join(f.codex, "thread-writer-locks", `${f.id}.lock`);
  await mkdir(dirname(lock), { recursive: true });
  const target = `mesh-resume-guard-release-${process.pid}`;
  const holder = `exec -a codex python3 -c 'import sys,time; h=open(sys.argv[1],"a"); time.sleep(60)' ${lock}`;
  assert.notEqual(tmux("new-session", "-d", "-s", target, "bash", "-c", holder), null);
  let held = false;
  for (let i = 0; i < 50 && !held; i++) {
    const status = await run(f, ["--agent", "codex", "writer-status", f.id, "--json"]);
    held = status.code === 0 && JSON.parse(status.stdout).writers.length === 1;
    if (!held) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(held, "fixture writer never took the lock");

  const released = await run(f, ["--agent", "codex", "release", target]);
  assert.equal(released.code, 0, released.stderr);
  assert.match(released.stdout, new RegExp(`thread ${f.id}: no writer`));
  assert.match(released.stdout, new RegExp(`Released ${target}`));
  assert.equal(tmux("has-session", "-t", target), null);

  const missing = await run(f, ["--agent", "codex", "release", target]);
  assert.equal(missing.code, 3);
});
