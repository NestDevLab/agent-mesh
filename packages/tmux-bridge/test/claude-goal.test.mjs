import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const bridge = fileURLToPath(new URL("../bin/agent-session.sh", import.meta.url));
const ids = {
  live: "55555555-5555-4555-8555-555555555551",
  busy: "55555555-5555-4555-8555-555555555552",
  bare: "55555555-5555-4555-8555-555555555553",
  dead: "55555555-5555-4555-8555-555555555554",
  done: "55555555-5555-4555-8555-555555555555",
  fresh: "55555555-5555-4555-8555-555555555556",
};

const goalRecord = (condition, met, extra = {}, at = new Date().toISOString()) =>
  JSON.stringify({ type: "attachment", timestamp: at, attachment: { type: "goal_status", met, condition, ...extra } });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "mesh-claude-goal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, ".claude", "projects", "synthetic-project");
  await mkdir(project, { recursive: true });
  await mkdir(join(root, ".claude", "sessions"));
  await mkdir(join(root, "proc"));
  const sender = join(root, "fake-send");
  await writeFile(sender, `exec "${process.execPath}" "${sender}.cjs" "$@"\n`);
  await writeFile(`${sender}.cjs`, `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SEND_LOG, JSON.stringify(args) + '\\n');
const code = Number(process.env.SEND_EXIT || 0);
if (code === 0) {
  const id = process.env.SEND_SESSION;
  const command = args.at(-1);
  const cleared = command === '/goal clear';
  fs.appendFileSync(process.env.SEND_TRANSCRIPT, JSON.stringify({ type: 'attachment', timestamp: new Date().toISOString(),
    attachment: { type: 'goal_status', met: cleared, sentinel: true, condition: cleared ? 'old' : command.slice(6) } }) + '\\n');
} else console.error('synthetic send failure');
process.exit(code);
`);
  const transcript = (id) => join(project, `${id}.jsonl`);
  const session = async (id, lines, minutesAgo = 0) => {
    await writeFile(transcript(id), `${JSON.stringify({ type: "user", cwd: root })}\n${lines.join("\n")}\n`);
    const at = new Date(Date.now() - minutesAgo * 60_000);
    await utimes(transcript(id), at, at);
  };
  let nextPid = 300;
  const live = async (id, fields) => {
    const pid = nextPid++;
    await mkdir(join(root, "proc", String(pid)));
    await writeFile(join(root, "proc", String(pid), "stat"), `${pid} (claude) S ${Array(18).fill("0").join(" ")} 4242 0\n`);
    await writeFile(join(root, ".claude", "sessions", `${pid}.json`),
      JSON.stringify({ pid, sessionId: id, procStart: "4242", ...fields }));
  };
  const env = {
    ...process.env, HOME: root, CLAUDE_CONFIG_DIR: join(root, ".claude"), CLAUDE_SESSION_ROOT: "",
    AGENT_WRITER_PROC_ROOT: join(root, "proc"), AGENT_GOAL_SENDER: sender, SEND_LOG: join(root, "send.log"),
    AGENT_GOAL_TIMEOUT_MS: "3000", MESH_GRAPH_DISABLE: "1",
  };
  const run = (args, extra = {}) => new Promise((resolve) => {
    execFile("bash", [bridge, "--agent", "claude", ...args], { cwd: root, env: { ...env, ...extra }, timeout: 15000 },
      (error, stdout, stderr) => resolve({ code: error?.code || 0, stdout, stderr }));
  });
  const sends = async () => {
    try { return (await readFile(env.SEND_LOG, "utf8")).trim().split("\n").map((line) => JSON.parse(line)); }
    catch { return []; }
  };
  return { root, run, session, live, sends, transcript };
}

test("Claude goal get reads the latest goal_status from the transcript", async (t) => {
  const f = await fixture(t);
  const cases = [
    [ids.live, [], { state: "none" }],
    [ids.busy, [goalRecord("Ship", false, { sentinel: true })], { state: "active", condition: "Ship", met: false }],
    [ids.done, [goalRecord("Ship", false, { sentinel: true }, "2026-01-01T00:00:00.000Z"),
      goalRecord("Ship", true, { reason: "All done" }, "2026-01-01T00:05:00.000Z")], { state: "achieved", met: true, reason: "All done" }],
    [ids.bare, [goalRecord("Ship", false, { reason: "Not yet" }, "2026-01-01T00:00:00.000Z"),
      goalRecord("Ship", true, { sentinel: true }, "2026-01-01T00:05:00.000Z")], { state: "cleared" }],
  ];
  for (const [id, lines, expected] of cases) {
    await f.session(id, lines);
    const response = await f.run(["goal", "get", id, "--json"]);
    assert.equal(response.code, 0, response.stderr);
    const goal = JSON.parse(response.stdout);
    for (const [key, value] of Object.entries(expected)) assert.equal(goal[key], value, `${id} ${key}`);
  }
});

test("Claude goal set and clear type /goal into an idle tmux-hosted session", async (t) => {
  const f = await fixture(t);
  await f.session(ids.live, []);
  await f.live(ids.live, { status: "idle", tmux: "mesh-claude-x:@1.%1" });
  const extra = { SEND_SESSION: ids.live, SEND_TRANSCRIPT: f.transcript(ids.live) };
  const set = await f.run(["goal", "set", ids.live, "--objective", "All checks\npass", "--json"], extra);
  assert.equal(set.code, 0, set.stderr);
  const receipt = JSON.parse(set.stdout);
  assert.equal(receipt.status, "submitted");
  assert.equal(receipt.via, "tmux");
  assert.equal(receipt.goalStateVerified, true);
  assert.equal(receipt.goal.condition, "All checks pass");
  const clear = await f.run(["goal", "clear", ids.live, "--json"], extra);
  assert.equal(clear.code, 0, clear.stderr);
  assert.equal(JSON.parse(clear.stdout).goal.state, "cleared");
  assert.deepEqual((await f.sends()).map((args) => args.slice(-2)),
    [["mesh-claude-x:@1.%1", "/goal All checks pass"], ["mesh-claude-x:@1.%1", "/goal clear"]]);
  assert.deepEqual((await f.sends())[0].slice(0, 4), ["--agent", "claude", "--submit-only", "--quiet"]);
});

test("Claude goal set refuses busy, non-tmux and failed sends on live sessions", async (t) => {
  const f = await fixture(t);
  for (const id of [ids.busy, ids.bare, ids.live]) await f.session(id, []);
  await f.live(ids.busy, { status: "busy", tmux: "mesh-claude-x:@2.%2" });
  await f.live(ids.bare, { status: "idle" });
  await f.live(ids.live, { status: "idle", tmux: "mesh-claude-x:@3.%3" });
  const busy = await f.run(["goal", "set", ids.busy, "--objective", "Ship"]);
  assert.equal(busy.code, 6);
  assert.match(busy.stderr, /busy/);
  const bare = await f.run(["goal", "set", ids.bare, "--objective", "Ship"]);
  assert.equal(bare.code, 3);
  assert.match(bare.stderr, /outside tmux/);
  assert.deepEqual(await f.sends(), []);
  const failed = await f.run(["goal", "set", ids.live, "--objective", "Ship"], { SEND_EXIT: "6" });
  assert.equal(failed.code, 6);
  assert.match(failed.stderr, /synthetic send failure/);
});

test("Claude goal-watch nudges stalled live goals and reports orphaned ones", async (t) => {
  const f = await fixture(t);
  const active = [goalRecord("Finish the release", false, { sentinel: true })];
  await f.session(ids.live, active, 45);
  await f.session(ids.busy, active, 45);
  await f.session(ids.dead, active, 45);
  await f.session(ids.fresh, active, 2);
  await f.session(ids.done, [goalRecord("Finish the release", true, { reason: "Done" })], 45);
  await f.live(ids.live, { status: "idle", tmux: "mesh-claude-x:@4.%4" });
  await f.live(ids.busy, { status: "busy", tmux: "mesh-claude-x:@5.%5" });
  const result = await f.run(["goal-watch", "--idle-minutes", "20", "--nudge", "--json"],
    { SEND_SESSION: ids.live, SEND_TRANSCRIPT: f.transcript(ids.live) });
  assert.equal(result.code, 0, result.stderr);
  const rows = JSON.parse(result.stdout).goals;
  assert.deepEqual(rows.map((row) => [row.sessionId, row.state, row.nudged]).sort(),
    [[ids.live, "stalled", true], [ids.dead, "orphaned", undefined]].sort());
  assert.deepEqual((await f.sends()).map((args) => args.at(-1)), ["/goal Finish the release"]);
});
