import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAppServer } from "./fixtures/fake-app-server.mjs";

const session = "22222222-2222-4222-8222-222222222222";
const bridge = fileURLToPath(new URL("../bin/agent-session.sh", import.meta.url));

async function fixture(t, respond, onPong) {
  const root = await mkdtemp(join(tmpdir(), "mesh-steer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sock = join(root, "server.sock");
  const requests = [];
  const server = createAppServer((message, peer) => {
    requests.push(message);
    if (message.id) respond(message, peer);
  }, onPong);
  await new Promise((resolve) => server.listen(sock, resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }));
  const run = (agent, args, extra = {}) => new Promise((resolve) => {
    execFile("bash", [bridge, "--agent", agent, "steer", ...args], {
      cwd: root,
      env: { ...process.env, HOME: root, CODEX_HOME: join(root, ".codex"), CODEX_REMOTE_SOCK: sock, CODEX_NO_REMOTE: "", MESH_GRAPH_DISABLE: "1", AGENT_STEER_TIMEOUT_MS: "3000", ...extra },
      timeout: 10000,
    }, (error, stdout, stderr) => resolve({ code: error?.code || 0, stdout, stderr }));
  });
  return { requests, run };
}

const activeTurn = (message, peer) => {
  if (message.method === "thread/turns/list") peer.send({ id: message.id, result: { data: [{ id: "turn-1", status: "inProgress" }] } });
  else if (message.method === "turn/steer") peer.send({ id: message.id, result: { turnId: "turn-1" } });
  else peer.send({ id: message.id, result: {} });
};

test("steer targets the active turn with the expected turn id", async (t) => {
  const f = await fixture(t, activeTurn);
  const response = await f.run("codex", [session, "--message", "Stop and read this", "--json"]);
  assert.equal(response.code, 0, response.stderr);
  assert.deepEqual(JSON.parse(response.stdout), { agent: "codex", sessionId: session, status: "steered", turnId: "turn-1" });
  assert.deepEqual(f.requests.map((request) => request.method), ["initialize", "initialized", "thread/turns/list", "turn/steer"]);
  assert.equal(f.requests[0].params.capabilities.experimentalApi, true);
  assert.deepEqual(f.requests[2].params, { threadId: session, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
  assert.deepEqual(f.requests[3].params, {
    threadId: session,
    input: [{ type: "text", text: "Stop and read this", text_elements: [] }],
    expectedTurnId: "turn-1",
  });
});

for (const [name, data] of [["finished", [{ id: "turn-1", status: "completed" }]], ["empty", []]]) {
  test(`steer sends nothing on a ${name} thread`, async (t) => {
    const f = await fixture(t, (message, peer) => {
      peer.send({ id: message.id, result: message.method === "thread/turns/list" ? { data } : {} });
    });
    const response = await f.run("codex", [session, "--message", "Too late"]);
    assert.equal(response.code, 3);
    assert.match(response.stderr, /no active turn; nothing was sent/);
    assert.equal(f.requests.some((request) => request.method === "turn/steer"), false);
  });
}

test("steer reports app-server errors", async (t) => {
  const f = await fixture(t, (message, peer) => {
    if (message.method === "turn/steer") peer.send({ id: message.id, error: { code: -32600, message: "turn is not steerable" } });
    else activeTurn(message, peer);
  });
  const response = await f.run("codex", [session, "--message", "Hello"]);
  assert.equal(response.code, 1);
  assert.match(response.stderr, /app-server: turn is not steerable/);
});

test("steer times out with an unknown outcome", async (t) => {
  const f = await fixture(t, (message, peer) => {
    if (message.method !== "turn/steer") activeTurn(message, peer);
  });
  const response = await f.run("codex", [session, "--message", "Hello"], { AGENT_STEER_TIMEOUT_MS: "300" });
  assert.equal(response.code, 124);
  assert.match(response.stderr, /outcome unknown/);
});

test("transport handles large fragmented responses and answers pings", async (t) => {
  const pongs = [];
  const f = await fixture(t, (message, peer) => {
    if (message.method === "thread/turns/list") {
      peer.ping("still-there");
      peer.sendFragmented({ id: message.id, result: { data: [{ id: "turn-1", status: "inProgress", padding: "x".repeat(200000) }] } });
    } else activeTurn(message, peer);
  }, (text) => pongs.push(text));
  const response = await f.run("codex", [session, "--message", "Hello", "--json"]);
  assert.equal(response.code, 0, response.stderr);
  assert.equal(JSON.parse(response.stdout).turnId, "turn-1");
  assert.deepEqual(pongs, ["still-there"]);
});

test("steer refuses Claude and invalid input before connecting", async (t) => {
  const f = await fixture(t, activeTurn);
  const cases = [
    ["claude", [session, "--message", "Hello"], /unsupported for claude/],
    ["codex", ["not-a-uuid", "--message", "Hello"], /complete UUID/],
    ["codex", [session], /requires --message/],
    ["codex", [session, "--message", "   "], /requires --message/],
  ];
  for (const [agent, args, expected] of cases) {
    const response = await f.run(agent, args);
    assert.equal(response.code, 1);
    assert.match(response.stderr, expected);
  }
  assert.deepEqual(f.requests, []);
});
