import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm, unlink, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { discoverOwnedCodexThread } from "../bin/codex-owned-pane.mjs";
const id = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "mesh-owned-pane-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const procRoot = join(base, "proc"), codexHome = join(base, "home/.codex"), cwd = join(base, "repo");
  await mkdir(procRoot); await mkdir(cwd); await mkdir(join(codexHome, "thread-writer-locks"), { recursive: true });
  const process = async (pid, parent, command = "codex", path = cwd) => {
    const root = join(procRoot, String(pid)); await mkdir(join(root, "fd"), { recursive: true });
    await writeFile(join(root, "stat"), `${pid} (${command}) S ${parent} ${Array(17).fill("0").join(" ")} 12345\n`);
    await symlink(`/opt/mesh-bin/${command}`, join(root, "exe"));
    await writeFile(join(root, "cmdline"), `/opt/mesh-bin/${command}\0`);
    await symlink(path, join(root, "cwd"));
  };
  const lock = async (pid, uuid = id, fd = "7", home = codexHome) => {
    const path = join(home, "thread-writer-locks", `${uuid}.lock`);
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, "");
    await symlink(path, join(procRoot, String(pid), "fd", fd));
  };
  await process(10, 1, "bash"); await process(12, 10); await lock(12);
  return { base, procRoot, codexHome, cwd, process, lock, options: { panePid: 10, cwd, procRoot, codexHome } };
}

test("native owned writer is resolved before DB/JSONL persistence", async t => {
  const f = await fixture(t);
  const proof = discoverOwnedCodexThread(f.options);
  assert.equal(proof.sessionId, id); assert.equal(proof.writers[0].pid, 12); assert.equal(proof.cwd, f.cwd);
  await assert.rejects(readFile(join(f.codexHome, "state_5.sqlite")), { code: "ENOENT" });
  await assert.rejects(readFile(join(f.codexHome, "sessions")), { code: "ENOENT" });
});
for (const [name, mutate] of [
  ["ambiguous native locks", async f => f.lock(12, second, "8")],
  ["fully observable foreign writer of the same UUID", async f => { await f.process(90, 1); await f.lock(90); }],
  ["unobservable foreign writer of the same UUID", async f => { await f.process(90, 1); await f.lock(90); await unlink(join(f.procRoot, "90/cmdline")); }],
  ["unobservable foreign wrapper of the same UUID", async f => { await f.process(90, 1, "node"); await f.lock(90); await unlink(join(f.procRoot, "90/cmdline")); }],
  ["unobservable foreign Codex descriptor inventory", async f => { await f.process(90, 1); await f.lock(90); await rm(join(f.procRoot, "90/fd"), { recursive: true }); }],
  ["unobservable foreign descriptor entry", async f => { await f.process(90, 1); await f.lock(90); await unlink(join(f.procRoot, "90/fd/7")); await writeFile(join(f.procRoot, "90/fd/7"), "unobservable"); }],
  ["multiple live writers", async f => { await f.process(13, 10); await f.lock(13); }],
  ["foreign pane", async f => { await f.process(90, 1, "bash"); f.options.panePid = 90; }],
  ["wrong cwd", async f => { f.options.cwd = f.base; }],
  ["stale lock without held descriptor", async f => unlink(join(f.procRoot, "12/fd/7"))],
  ["missing live writer", async f => rm(join(f.procRoot, "12"), { recursive: true })],
  ["foreign home lock", async f => { await unlink(join(f.procRoot, "12/fd/7")); await f.lock(12, id, "7", join(f.base, "foreign")); }],
  ["symlink lock inode", async f => { const path = join(f.codexHome, "thread-writer-locks", id + ".lock"); await unlink(path); const target = join(f.base, "other"); await writeFile(target, ""); await symlink(target, path); }],
  ["incomplete process inventory", async f => writeFile(join(f.procRoot, "12/stat"), "malformed")]
]) test(`owned discovery denies ${name}`, async t => {
  const f = await fixture(t); await mutate(f);
  assert.throws(() => discoverOwnedCodexThread(f.options));
});

test("bridge owned-cwd target resolution uses exact pane without touching DB reconciliation", async t => {
  const f = await fixture(t); const bin = join(f.base, "bin"); await mkdir(bin);
  await writeFile(join(bin, "tmux"), '#!/bin/bash\nprintf "mesh-owned|10|codex|0|0\\n"\n', { mode: 0o755 });
  const database = join(f.codexHome, "state_5.sqlite"), events = join(f.base, "launch-events.jsonl");
  const emptyDatabase = spawnSync("python3", ["-c", 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript("CREATE TABLE threads(id TEXT,cwd TEXT,created_at_ms INTEGER,created_at INTEGER); CREATE TABLE thread_spawn_edges(child_thread_id TEXT);"); c.close()', database]);
  assert.equal(emptyDatabase.status, 0);
  const record = spawnSync("python3", [fileURLToPath(new URL("../bin/bridge-launch-record.py", import.meta.url)), "--state", events, "start", "--agent", "codex", "--target", "mesh-owned", "--cwd", f.cwd, "--route-status", "not_requested"]);
  assert.equal(record.status, 0, String(record.stderr));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: join(f.base, "home"), AGENT_WRITER_PROC_ROOT: f.procRoot, MESH_GRAPH_DISABLE: "1", CODEX_NO_REMOTE: "1", MESH_LAUNCH_RECORD_FILE: events };
  const persistedOnly = spawnSync("bash", [fileURLToPath(new URL("../bin/agent-session.sh", import.meta.url)), "--agent", "codex", "target-session", "mesh-owned"], { encoding: "utf8", env });
  assert.equal(persistedOnly.status, 4); assert.match(persistedOnly.stderr, /no uniquely resolved session/);
  const ambiguous = JSON.parse((await readFile(events, "utf8")).trim().split("\n").at(-1));
  assert.equal(ambiguous.event, "launch.thread_ambiguous"); assert.equal(ambiguous.candidateCount, 0);
  const result = spawnSync("bash", [fileURLToPath(new URL("../bin/agent-session.sh", import.meta.url)), "--agent", "codex", "target-session", "mesh-owned", "--owned-cwd", f.cwd], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), id);
});

test("owned proof resolves a real fixture process's held native lock FD", async t => {
  const f = await fixture(t); const script = join(f.base, "codex");
  await writeFile(script, 'import {openSync} from "node:fs"; openSync(process.argv[2], "r"); console.log("ready"); setInterval(()=>{},1000);');
  const child = spawn(process.execPath, [script, join(f.codexHome, "thread-writer-locks", id + ".lock")], { cwd: f.cwd, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  await new Promise((ok, fail) => { child.stdout.once("data", ok); child.once("error", fail); child.once("exit", code => fail(new Error(`fixture exited ${code}`))); });
  // Expose a complete inventory containing only this real fixture process;
  // never silently filter privileged/unobservable processes from host /proc.
  const procRoot = join(f.base, "live-proc"), proc = join(procRoot, String(child.pid));
  await mkdir(proc, { recursive: true });
  for (const name of ["stat", "cmdline", "fd", "cwd", "exe"]) await symlink(`/proc/${child.pid}/${name}`, join(proc, name));
  // cwd/exe are readlink evidence, so project their real targets directly.
  await unlink(join(proc, "cwd")); await symlink(f.cwd, join(proc, "cwd"));
  const proof = discoverOwnedCodexThread({ panePid: child.pid, cwd: f.cwd, codexHome: f.codexHome, procRoot });
  assert.equal(proof.sessionId, id); assert.equal(proof.writers[0].pid, child.pid);
});


test("observable foreign Codex writer of a different UUID does not claim the owned thread", async t => {
  const f = await fixture(t); await f.process(90, 1); await f.lock(90, second);
  assert.equal(discoverOwnedCodexThread(f.options).sessionId, id);
});


test("real helper CLI inventories its own transient FDs and refuses inherited native locks", async t => {
  const f = await fixture(t), script = join(f.base, "observer.mjs");
  await writeFile(script, `import {mkdirSync,symlinkSync,readlinkSync,openSync} from "node:fs";
const directory=process.env.AGENT_WRITER_PROC_ROOT+"/"+process.pid;
mkdirSync(directory);
for(const name of ["stat","cmdline","fd"]) symlinkSync("/proc/"+process.pid+"/"+name,directory+"/"+name);
for(const name of ["cwd","exe"]) symlinkSync(readlinkSync("/proc/self/"+name),directory+"/"+name);
if(process.env.FIXTURE_INHERIT_LOCK) openSync(process.env.FIXTURE_INHERIT_LOCK,"r");
await import(${JSON.stringify(new URL("../bin/session-writer-status.mjs", import.meta.url).href)});`);
  const env = { ...process.env, HOME: join(f.base, "home"), AGENT_WRITER_PROC_ROOT: f.procRoot };
  const args = [script, "--agent", "codex", "--owned-pane-pid", "10", "--cwd", f.cwd, "--json"];
  const ok = spawnSync(process.execPath, args, { encoding: "utf8", env });
  assert.equal(ok.status, 0, ok.stderr); assert.equal(JSON.parse(ok.stdout).sessionId, id);
  // The first observer has exited; remove its fixture projection before the next inventory.
  for (const name of await readdir(f.procRoot)) if (!["10","12"].includes(name)) await rm(join(f.procRoot,name), {recursive:true});
  const inherited = spawnSync(process.execPath, args, { encoding: "utf8", env: { ...env, FIXTURE_INHERIT_LOCK: join(f.codexHome, "thread-writer-locks", id + ".lock") } });
  assert.equal(inherited.status, 4); assert.match(inherited.stderr, /incomplete or ambiguous/);
});

test("bounded readiness retries keep the original pane process identity", async t => {
  const { waitForOwnedCodexThread } = await import("../bin/codex-owned-pane.mjs");
  const f = await fixture(t); await unlink(join(f.procRoot, "12/fd/7"));
  let clock = 0;
  await assert.rejects(waitForOwnedCodexThread(f.options, { timeoutMs: 500, now: () => clock, wait: async ms => {
    clock += ms;
    const path = join(f.procRoot, "10/stat");
    const original = await readFile(path, "utf8"); await writeFile(path, original.replace("12345", "12346"));
  } }), error => error.proofStage === "pane.identity");
});

test("bounded readiness does not accept proof appearing after its monotonic deadline", async t => {
  const { waitForOwnedCodexThread } = await import("../bin/codex-owned-pane.mjs");
  const f = await fixture(t); await unlink(join(f.procRoot, "12/fd/7"));
  let clock = 0, waits = 0;
  await assert.rejects(waitForOwnedCodexThread(f.options, { timeoutMs: 10, intervalMs: 100, now: () => clock, wait: async ms => {
    waits++; clock += ms; await f.lock(12);
  } }));
  assert.equal(waits, 1); assert.equal(clock, 10);
});

test("bounded readiness can observe a native lock appearing on the same pinned pane", async t => {
  const { waitForOwnedCodexThread } = await import("../bin/codex-owned-pane.mjs");
  const f = await fixture(t); await unlink(join(f.procRoot, "12/fd/7"));
  let clock = 0;
  const proof = await waitForOwnedCodexThread(f.options, { timeoutMs: 500, now: () => clock, wait: async ms => { clock += ms; await f.lock(12); } });
  assert.equal(proof.sessionId, id);
});
