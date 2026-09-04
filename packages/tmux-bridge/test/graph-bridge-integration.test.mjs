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
    MESH_TMUX_SOCKET: socket,
    XDG_CONFIG_HOME: join(root, "config"),
    MESH_WORK_CLASS: "L1",
    AGENT_POLL_INTERVAL: "0.1",
    AGENT_IDLE_ROUNDS: "2",
  };

  try {
    await mkdir(agents);
    await mkdir(sessions);
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
      'AGENT_NEW_CMD="env PS1=\'GRAPH> \' bash --noprofile --norc -i"',
      `AGENT_SESSION_DIR="${sessions}"`,
      "AGENT_SESSION_CWD_EXTRACTOR='printf \"%s\\n\" \"/graph/workspace\"; :'",
    ].join("\n") + "\n");

    const parent = await run(process.execPath, [graphBin, "--state", state, "add", "--agent", "claude", "--tmux-target", parentTarget, "--summary", "PO", "--json"], environment);
    assert.equal(parent.code, 0, parent.stderr);

    const launched = await run(sessionBin, ["--agent", agent, "--profile", "developer", "--limen-config", "missing-policy", "new", root, target], {
      ...environment,
      LIMEN_BIN: join(root, "missing-limen"),
    });
    assert.equal(launched.code, 0, launched.stderr);
    assert.equal(launched.stdout.trim(), target);

    await writeFile(join(sessions, `rollout-${runtimeUuid}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { cwd: "/graph/workspace" } })}\n`);
    const inspected = await run(sessionBin, ["--agent", agent, "inspect", runtimeUuid, "--json", "--graph-target", target], environment);
    assert.equal(inspected.code, 0, inspected.stderr);

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
  } finally {
    await run("tmux", ["-L", socket, "kill-server"], environment);
    await rm(root, { recursive: true, force: true });
  }
});
