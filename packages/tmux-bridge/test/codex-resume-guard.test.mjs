import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
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

const SETTLE = { MESH_RELEASE_SETTLE_SECONDS: "0.3" };
const runAsync = (f, args, env) => run(f, args, env);

function rolloutPath(f) {
  return join(f.codex, "sessions", "2026", "01", "01", `rollout-2026-01-01T00-00-00-${f.id}.jsonl`);
}

// The holder takes the writer lock like a CLI does; with onInput it records a
// turn for every line typed into the pane, so blocked input is observable. Its
// script file is named app-server when it must look like `codex app-server`.
const HOLDER = [
  "import json,sys,time",
  "h=open(sys.argv[1],'a')",
  "print(sys.argv[2], flush=True)",
  "if sys.argv[3]=='1':",
  "    for line in sys.stdin:",
  "        open(sys.argv[4],'a').write(json.dumps({'type':'event_msg','payload':{'type':'task_started'}})+'\\n')",
  "time.sleep(60)",
].join("\n");

async function holderScript(f, server) {
  const dir = join(f.home, server ? "server-bin" : "cli-bin");
  await mkdir(dir, { recursive: true });
  const name = server ? "app-server" : "holder.py";
  await writeFile(join(dir, name), HOLDER + "\n");
  return { dir, name };
}

async function holdLock(f, target, { banner = "", server = false, onInput = false } = {}) {
  const lock = join(f.codex, "thread-writer-locks", `${f.id}.lock`);
  await mkdir(dirname(lock), { recursive: true });
  const { dir, name } = await holderScript(f, server);
  const holder = `cd ${dir} && exec -a codex python3 ${name} ${lock} '${banner}' ${onInput ? 1 : 0} ${rolloutPath(f)}`;
  assert.notEqual(tmux("new-session", "-d", "-s", target, "bash", "-c", holder), null);
  for (let i = 0; i < 50; i++) {
    const status = await run(f, ["--agent", "codex", "writer-status", f.id, "--json"]);
    if (status.code === 0 && JSON.parse(status.stdout).writers.length === 1) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail("fixture writer never took the lock");
}

async function writeTurn(f, events, { padding = 0, tail = "" } = {}) {
  await mkdir(dirname(rolloutPath(f)), { recursive: true });
  const lines = [{ type: "session_meta", payload: { id: f.id, cwd: f.home } }];
  for (const type of events) {
    lines.push({ type: "event_msg", payload: { type } });
    if (type === "task_started" && padding) {
      const chunk = "x".repeat(64 * 1024);
      for (let i = 0; i < padding; i++) lines.push({ type: "response_item", payload: { type: "message", text: chunk } });
    }
  }
  await writeFile(rolloutPath(f), lines.map((l) => JSON.stringify(l)).join("\n") + "\n" + tail);
}

const turnsIn = async (f) => (await readFile(rolloutPath(f), "utf8")).split("\n").filter((l) => l.includes("task_started")).length;

async function waitInputOff(target) {
  for (let i = 0; i < 100; i++) {
    if (tmux("display-message", "-p", "-t", target, "#{pane_input_off}")?.trim() === "1") return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail("release never blocked pane input");
}

test("release kills an idle target and proves its CLI writer is gone", async () => {
  const f = await fixture("75000000-0000-4000-8000-000000000005");
  await writeTurn(f, ["task_started", "task_complete"]);
  const target = `mesh-resume-guard-release-${process.pid}`;
  await holdLock(f, target);

  const released = await run(f, ["--agent", "codex", "release", target], SETTLE);
  assert.equal(released.code, 0, released.stderr);
  assert.match(released.stdout, new RegExp(`thread ${f.id}: no writer`));
  assert.match(released.stdout, new RegExp(`Released ${target}`));
  assert.equal(tmux("has-session", "-t", target), null);

  const missing = await run(f, ["--agent", "codex", "release", target], SETTLE);
  assert.equal(missing.code, 3);
});

test("release refuses before any kill unless the turn is proven complete", async () => {
  const cases = [
    ["open turn in the rollout", ["task_started"], {}, {}, /turn in progress/],
    ["open turn followed by more than 4 MiB of output", ["task_started"], { padding: 72 }, {}, /turn in progress/],
    ["corrupt line after a finished turn", ["task_started", "task_complete"], { tail: "{not json\n" }, {}, /complete, readable rollout/],
    ["partial last line", ["task_started", "task_complete"], { tail: '{"type":"event_msg"' }, {}, /complete, readable rollout/],
    ["no rollout", null, {}, {}, /complete, readable rollout/],
    ["busy pane", ["task_started", "task_complete"], {}, { banner: "Working (esc to interrupt)" }, /busy/],
    ["app-server writer inside the target", ["task_started", "task_complete"], {}, { server: true }, /can't be quiesced/],
  ];
  for (const [index, [name, events, rollout, holder, expected]] of cases.entries()) {
    const f = await fixture(`7600000${index}-0000-4000-8000-000000000006`);
    if (events) await writeTurn(f, events, rollout);
    const target = `mesh-resume-guard-busy-${index}-${process.pid}`;
    await holdLock(f, target, holder);
    const refused = await run(f, ["--agent", "codex", "release", target], SETTLE);
    assert.equal(refused.code, 4, `${name}: ${refused.stderr}`);
    assert.match(refused.stderr, expected, name);
    assert.notEqual(tmux("has-session", "-t", target), null, `${name}: target was killed`);
    assert.equal(tmux("display-message", "-p", "-t", target, "#{pane_input_off}")?.trim(), "0", `${name}: input left blocked`);
    tmux("kill-session", "-t", target);
  }
});

test("input typed while release holds the pane never reaches the agent", async () => {
  const f = await fixture("78000000-0000-4000-8000-000000000008");
  await writeTurn(f, ["task_started", "task_complete"]);
  const target = `mesh-resume-guard-gap-tmux-${process.pid}`;
  await holdLock(f, target, { onInput: true });
  tmux("send-keys", "-t", target, "control turn", "Enter");
  for (let i = 0; i < 50 && await turnsIn(f) < 2; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(await turnsIn(f), 2, "fixture never recorded typed input");
  await appendFile(rolloutPath(f), JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }) + "\n");
  const pending = runAsync(f, ["--agent", "codex", "release", target], { MESH_RELEASE_SETTLE_SECONDS: "1.5" });
  await waitInputOff(target);
  tmux("send-keys", "-t", target, "start a turn", "Enter");
  const released = await pending;
  assert.equal(released.code, 0, released.stderr);
  assert.equal(await turnsIn(f), 2, "typed input started a turn during release");
  assert.equal(tmux("has-session", "-t", target), null);
});

test("a turn that starts outside tmux during the hold aborts the release", async () => {
  const f = await fixture("79000000-0000-4000-8000-000000000009");
  await writeTurn(f, ["task_started", "task_complete"]);
  const target = `mesh-resume-guard-gap-file-${process.pid}`;
  await holdLock(f, target);
  const pending = runAsync(f, ["--agent", "codex", "release", target], { MESH_RELEASE_SETTLE_SECONDS: "2" });
  await waitInputOff(target);
  // land the turn after the first idle proof, inside the hold
  await new Promise((r) => setTimeout(r, 800));
  await appendFile(rolloutPath(f), JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }) + "\n");
  const started = Date.now();
  const refused = await pending;
  assert.equal(refused.code, 4, refused.stderr);
  assert.match(refused.stderr, /turn in progress|rollout changed/);
  assert.ok(Date.now() - started > 300, "release refused before the hold ended");
  assert.notEqual(tmux("has-session", "-t", target), null);
  assert.equal(tmux("display-message", "-p", "-t", target, "#{pane_input_off}")?.trim(), "0");
  tmux("kill-session", "-t", target);
});

test("a TUI client of an app-server-served thread is released while its turn runs", async () => {
  const cases = [
    ["active turn", "", 0, /turn continues in app-server/],
    ["approval prompt", "Allow command?\nPress enter to confirm", 4, /approval prompt or queued input/],
    ["queued follow-up", "Queued follow-up inputs\n  next step", 4, /approval prompt or queued input/],
  ];
  for (const [index, [name, banner, code, expected]] of cases.entries()) {
    const f = await fixture(`7a00000${index}-0000-4000-8000-00000000000a`);
    await writeTurn(f, ["task_started"]);
    const server = `mesh-resume-guard-server-${index}-${process.pid}`;
    const client = `mesh-resume-guard-client-${index}-${process.pid}`;
    await holdLock(f, server, { server: true });
    assert.notEqual(tmux("new-session", "-d", "-s", client, "bash", "-c", `printf '%b\\n' '${banner}'; exec sleep 60`), null);
    const result = await run(f, ["--agent", "codex", "release", client, f.id], SETTLE);
    assert.equal(result.code, code, `${name}: ${result.stderr}`);
    const out = code === 0 ? result.stdout : result.stderr;
    assert.match(out, expected, name);
    assert.equal(tmux("has-session", "-t", client) === null, code === 0, `${name}: client state`);
    assert.notEqual(tmux("has-session", "-t", server), null, `${name}: app-server fixture was touched`);
    if (code !== 0) assert.equal(tmux("display-message", "-p", "-t", client, "#{pane_input_off}")?.trim(), "0");
    tmux("kill-session", "-t", client);
    tmux("kill-session", "-t", server);
  }
});

test("writer role comes from the Codex subcommand, not from prompt text", async () => {
  const cases = [
    [["/opt/codex/codex", "resume", "SESSION", "app-server"], "cli"],
    [["/opt/codex/codex", "exec", "app-server"], "cli"],
    [["/opt/codex/codex", "--unknown-flag", "app-server"], "cli"],
    [["/opt/codex/codex", "-c", "features.x=true", "app-server", "--listen", "unix://"], "app-server"],
    [["/opt/codex/codex", "--config=features.x=true", "app-server"], "app-server"],
    [["node", "/opt/pkg/.bin/codex", "app-server", "--listen", "stdio://"], "app-server"],
  ];
  for (const [index, [argv, role]] of cases.entries()) {
    const f = await fixture(`7b00000${index}-0000-4000-8000-00000000000b`);
    const procRoot = await fakeWriter(f, argv.map((a) => a === "SESSION" ? f.id : a));
    const status = await run(f, ["--agent", "codex", "writer-status", f.id, "--json"], { AGENT_WRITER_PROC_ROOT: procRoot });
    assert.equal(JSON.parse(status.stdout).writers[0].role, role, argv.join(" "));
  }
});

test("a writer spawned inside the target after the pane scan is never treated as external", async () => {
  const guard = join(packageRoot, "bin", "codex-thread-guard.py");
  const f = await fixture("7c000000-0000-4000-8000-00000000000c");
  await writeTurn(f, ["task_started"]);
  const lock = join(f.codex, "thread-writer-locks", `${f.id}.lock`);
  await mkdir(dirname(lock), { recursive: true });
  const target = `mesh-resume-guard-late-${process.pid}`;
  // the pane starts a child `codex app-server` lookalike only once release has blocked input
  const { dir } = await holderScript(f, true);
  const pane = `until [ "$(tmux -L ${socket} display-message -p -t ${target} '#{pane_input_off}')" = 1 ]; do sleep 0.02; done; (cd ${dir} && exec -a codex python3 app-server ${lock} late 0 ${rolloutPath(f)}) & wait`;
  assert.notEqual(tmux("new-session", "-d", "-s", target, "bash", "-c", pane), null);
  const panePid = tmux("display-message", "-p", "-t", target, "#{pane_pid}").trim();

  const released = await run(f, ["--agent", "codex", "release", target, f.id], SETTLE);
  assert.equal(released.code, 4, released.stderr);
  assert.notEqual(tmux("has-session", "-t", target), null, "target was killed");
  let writer;
  for (let i = 0; i < 50 && !writer; i++) {
    const status = await run(f, ["--agent", "codex", "writer-status", f.id, "--json"]);
    writer = JSON.parse(status.stdout).writers[0];
    if (!writer) await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(writer?.role, "app-server", "fixture child never took the lock");

  // with only the pane root known, the late child must count as inside the target
  const env = { ...process.env, HOME: f.home, CODEX_HOME: f.codex };
  let served = 0;
  try { execFileSync("python3", [guard, "served", "--session", f.id, "--pane-pid", panePid], { env, stdio: "ignore" }); }
  catch (error) { served = error.status; }
  assert.equal(served, 1);
  tmux("kill-session", "-t", target);
});

test("release of a Codex target with no known thread asks for the session id", async () => {
  const f = await fixture("77000000-0000-4000-8000-000000000007");
  const target = `mesh-resume-guard-unknown-${process.pid}`;
  assert.notEqual(tmux("new-session", "-d", "-s", target, "sleep", "60"), null);
  const refused = await run(f, ["--agent", "codex", "release", target], SETTLE);
  assert.equal(refused.code, 4, refused.stderr);
  assert.match(refused.stderr, /pass its SESSION_ID/);
  assert.notEqual(tmux("has-session", "-t", target), null);
  tmux("kill-session", "-t", target);
});
