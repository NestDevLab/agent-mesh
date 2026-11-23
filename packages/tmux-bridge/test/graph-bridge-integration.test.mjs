import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sessionBin = join(packageRoot, "bin", "agent-session.sh");
const sendBin = join(packageRoot, "bin", "mesh-send.sh");
const graphBin = join(packageRoot, "bin", "mesh-graph.mjs");

async function run(command, args, environment) {
  try {
    const result = await exec(command, args, { env: environment });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("bridge lifecycle registers generated nodes, reconciliation, and delegated sends", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-graph-bridge-"));
  const agents = join(root, "agents");
  const sessions = join(root, "sessions");
  const state = join(root, "state");
  const launchEvents = join(root, "launch-events.jsonl");
  const capacity = join(root, "capacity.json");
  const limen = join(root, "limen");
  const launcher = join(root, "launch-agent");
  let launchedSession = false;
  const codexDb = join(root, "state_5.sqlite");
  const socket = `mesh-graph-bridge-${process.pid}-${Date.now()}`;
  // Session admission accepts runtime providers only. The temporary config
  // therefore models a Codex runtime while exposing a graph-worker alias.
  const agent = "codex";
  const target = `mesh-${agent}-main`;
  const parentTarget = "mesh-parent";
  const runtimeUuid = "55555555-5555-4555-8555-555555555555";
  const environment = {
    ...process.env,
    AGENT_MESH_AGENTS_DIR: agents,
    MESH_GRAPH_STATE: state,
    MESH_GRAPH_DISABLE: "0",
    MESH_GRAPH_PARENT_TARGET: parentTarget,
    MESH_LAUNCH_RECORD_FILE: launchEvents,
    MESH_CAPACITY_STATE: capacity,
    MESH_LEASE_RENEW_MS: "30",
    LIMEN_BIN: limen,
    CODEX_STATE_DB: codexDb,
    MESH_TMUX_SOCKET: socket,
    XDG_CONFIG_HOME: join(root, "config"),
    MESH_WORK_CLASS: "L1",
    AGENT_POLL_INTERVAL: "0.1",
    AGENT_IDLE_ROUNDS: "2",
  };

  try {
    await mkdir(agents);
    await mkdir(sessions);
    await writeFile(launcher, "#!/bin/sh\nexec env PS1='GRAPH> ' bash --noprofile --norc -i\n", { mode: 0o700 });
    await writeFile(limen, `#!/bin/sh
case "$1" in
  route) echo '{"decision":"route","mode":"enforce","provider":"codex","model":"fixture","nativeModel":"fixture","effort":"medium","lease":{"expiresAt":4102444800000,"candidate":{"key":"0123456789abcdef0123456789abcdef"}}}' ;;
  renew) echo '{"status":"renewed","expiresAt":4102444800000}' ;;
  complete) echo '{"status":"completed"}' ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
    await writeFile(join(agents, `${agent}.conf`), [
      'AGENT_BIN="bash"',
      'AGENT_SUBMIT_KEY="Enter"',
      'AGENT_PROMPT_CHAR="GRAPH>"',
      'MESH_AGENT_NAME="graph-worker"',
      'MESH_AGENT_CAPABILITIES="graph"',
      'AGENT_WORKING_PATTERN="__graph_never_working__"',
      'AGENT_IDLE_PATTERN="GRAPH>"',
      'AGENT_CONFIRM_FAST_IDLE="true"',
      'AGENT_ALIVE_PROCESS_PATTERN="^bash$"',
      'AGENT_RESUME_CMD="env PS1=\'GRAPH> \' bash --noprofile --norc -i"',
      'AGENT_HAS_CWD_PICKER="false"',
      'AGENT_PICKER_PATTERN=""',
      `AGENT_NEW_CMD="${launcher}"`,
      'AGENT_SUPPORTS_MODEL="true"',
      'AGENT_MODEL_ARGS=(--model "{VALUE}")',
      `AGENT_SESSION_DIR="${sessions}"`,
      "AGENT_SESSION_CWD_EXTRACTOR='printf \"%s\\n\" \"/graph/workspace\"; :'",
    ].join("\n") + "\n");

    const parent = await run(process.execPath, [graphBin, "--state", state, "add", "--agent", "claude", "--tmux-target", parentTarget, "--summary", "PO", "--json"], environment);
    assert.equal(parent.code, 0, parent.stderr);

    const launched = await run(sessionBin, ["--profile", "developer", "--limen-config", "fixture-policy", "new", root, target], environment);
    assert.equal(launched.code, 0, launched.stderr);
    launchedSession = true;
    assert.equal(launched.stdout.trim(), target);

    const launch = JSON.parse((await readFile(launchEvents, "utf8")).trim());
    const createDb = await run("python3", ["-c", `
import sqlite3, sys
connection = sqlite3.connect(sys.argv[1])
connection.executescript("""
CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, created_at INTEGER NOT NULL, created_at_ms INTEGER);
CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL);
""")
connection.execute("INSERT INTO threads(id, cwd, created_at, created_at_ms) VALUES(?, ?, ?, ?)", (sys.argv[2], sys.argv[4], 1, int(sys.argv[3]) + 1))
connection.commit()
`, codexDb, runtimeUuid, String(launch.launchedAtMs), launch.cwd], environment);
    assert.equal(createDb.code, 0, createDb.stderr);

    const delivered = await run(sendBin, [
      "--to", "graph-worker", "--target", target,
      "--from", "po", "--from-agent", "claude", "--from-target", parentTarget,
      "--intent", "request", "{ echo 'mesh graph delivery'; }", "10",
    ], environment);
    assert.equal(delivered.code, 0, delivered.stderr);

    const graph = await run(process.execPath, [graphBin, "--state", state, "show", "--json"], environment);
    assert.equal(graph.code, 0, graph.stderr);
    const payload = JSON.parse(graph.stdout);
    const worker = payload.nodes.find((node) => node.tmuxTarget === target);
    const parentNode = payload.nodes.find((node) => node.tmuxTarget === parentTarget);
    assert.ok(worker);
    assert.equal(worker.runtimeUuid, runtimeUuid);
    assert.equal(worker.roleProfile, "developer");
    assert.ok(payload.edges.some((edge) => edge.from === parentNode.id && edge.to === worker.id && edge.type === "spawned-by"));
    assert.ok(payload.edges.some((edge) => edge.from === parentNode.id && edge.to === worker.id && edge.type === "delegates-to"));
    assert.match(await readFile(join(state, "events.jsonl"), "utf8"), /node\.upserted/);
    const launchRecords = (await readFile(launchEvents, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(launchRecords.some(event => event.event === "launch.thread_resolved" && event.threadId === runtimeUuid));
  } finally {
    await run("tmux", ["-L", socket, "kill-server"], environment);
    if (launchedSession) {
      for (let attempt = 0; attempt < 50; attempt++) {
        const state = JSON.parse(await readFile(capacity, "utf8"));
        if (state.sessions[0]?.status === "completed") break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
