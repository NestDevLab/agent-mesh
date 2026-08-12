import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const dispatcher = new URL("../bin/mesh-capacity-dispatch.mjs", import.meta.url).pathname;
const meshSend = new URL("../bin/mesh-send.sh", import.meta.url).pathname;

test("deferred tmux work persists, exits 75, and drains in class priority", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mesh-capacity-"));
  const state = join(dir, "queue.json"), marker = join(dir, "admit"), sends = join(dir, "sends.txt");
  const limen = join(dir, "fake-limen.sh"), sender = join(dir, "fake-send.sh");
  await writeFile(limen, `#!/bin/sh\nif [ "$1" = complete ]; then echo '{"status":"completed"}'; exit 0; fi\nclass=L1\nprev=\nfor arg in "$@"; do [ "$prev" = --class ] && class="$arg"; prev="$arg"; done\nif [ -f '${marker}' ]; then echo "{\\"decision\\":\\"admit\\",\\"retryAt\\":null,\\"decisionId\\":\\"admit-$class\\",\\"configHash\\":\\"cfg\\",\\"workClass\\":\\"$class\\",\\"concurrencyTarget\\":1,\\"reasons\\":[\\"available\\"]}"; exit 0; fi\necho "{\\"decision\\":\\"defer\\",\\"retryAt\\":0,\\"decisionId\\":\\"defer-$class\\",\\"configHash\\":\\"cfg\\",\\"workClass\\":\\"$class\\",\\"concurrencyTarget\\":0,\\"reasons\\":[\\"over_pace\\"]}"; exit 75\n`);
  await writeFile(sender, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${sends}'\n`);
  await chmod(limen, 0o700); await chmod(sender, 0o700);
  for (const workClass of ["L3", "L1", "L2"]) {
    const result = await run(["submit", "--state", state, "--limen", limen, "--policy", "policy", "--provider", "codex", "--harness", "codex", "--run-id", `run-${workClass}`, "--class", workClass, "--", sender, workClass]);
    assert.equal(result.code, 75); assert.match(result.stderr, /waiting_capacity/);
  }
  assert.equal((await stat(state)).mode & 0o777, 0o600);
  await writeFile(marker, "admit\n");
  const drained = await run(["drain", "--state", state, "--now", "1"]);
  assert.equal(drained.code, 0);
  assert.deepEqual((await readFile(sends, "utf8")).trim().split("\n"), ["L1", "L2", "L3"]);
  const ledger = JSON.parse(await readFile(state, "utf8"));
  assert.ok(ledger.jobs.every(job => job.status === "dispatched"));
  const eventPath = `${state}.events.ndjson`;
  assert.equal((await stat(eventPath)).mode & 0o777, 0o600);
  const events = (await readFile(eventPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.ok(events.some(event => event.status === "waiting_capacity"));
  assert.ok(events.some(event => event.status === "claimed"));
  assert.equal(events.filter(event => event.status === "dispatched").length, 3);
  assert.ok(events.every(event => event.event === "limen.queue" && /^[a-f0-9]{64}$/.test(event.runHash)));
  assert.doesNotMatch(JSON.stringify(events), /run-L[123]/);
});

test("completion preserves the admission session lineage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mesh-capacity-session-"));
  const state = join(dir, "queue.json"), argsFile = join(dir, "complete-args.txt");
  const limen = join(dir, "fake-limen.sh"), sender = join(dir, "fake-send.sh");
  await writeFile(limen, `#!/bin/sh\nif [ "$1" = complete ]; then printf '%s\\n' "$@" > '${argsFile}'; echo '{"status":"completed"}'; exit 0; fi\necho '{"decision":"admit","retryAt":null,"decisionId":"d","configHash":"c","workClass":"L2","concurrencyTarget":1,"reasons":["available"]}'\n`);
  await writeFile(sender, "#!/bin/sh\nexit 0\n");
  await chmod(limen, 0o700); await chmod(sender, 0o700);
  const result = await run(["submit", "--state", state, "--limen", limen, "--policy", "policy", "--provider", "codex", "--harness", "codex", "--run-id", "private-run", "--class", "L2", "--session", "session-1", "--", sender]);
  assert.equal(result.code, 0);
  assert.match(await readFile(argsFile, "utf8"), /--session\nsession-1/);
  const events = await readFile(`${state}.events.ndjson`, "utf8");
  assert.doesNotMatch(events, /private-run|session-1/);
});

test("post-dispatch evidence failure never converts a delivered command into a retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mesh-capacity-evidence-"));
  const state = join(dir, "queue.json"), events = join(dir, "events.ndjson");
  const limen = join(dir, "fake-limen.sh"), sender = join(dir, "fake-send.sh");
  await writeFile(limen, "#!/bin/sh\nif [ \"$1\" = complete ]; then echo '{\"status\":\"completed\"}'; exit 0; fi\necho '{\"decision\":\"admit\",\"decisionId\":\"d\",\"configHash\":\"c\",\"workClass\":\"L2\",\"reasons\":[\"available\"]}'\n");
  await writeFile(sender, `#!/bin/sh\nrm '${events}'\nmkdir '${events}'\nexit 0\n`);
  await chmod(limen, 0o700); await chmod(sender, 0o700);
  const result = await run(["submit", "--state", state, "--events", events, "--limen", limen, "--policy", "policy", "--provider", "codex", "--harness", "codex", "--run-id", "one-shot", "--class", "L2", "--", sender]);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /evidence unavailable after dispatch/);
});

test("uncertain post-dispatch state is quarantined and never automatically redelivered", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mesh-capacity-uncertain-"));
  const state = join(dir, "queue.json"), lock = `${state}.lock`, marker = join(dir, "admit"), sends = join(dir, "sends.txt");
  const limen = join(dir, "fake-limen.sh"), sender = join(dir, "fake-send.sh");
  await writeFile(limen, `#!/bin/sh\nif [ "$1" = complete ]; then echo '{"status":"completed"}'; exit 0; fi\nif [ -f '${marker}' ]; then echo '{"decision":"admit","decisionId":"d","configHash":"c","workClass":"L3","reasons":["available"]}'; exit 0; fi\necho '{"decision":"defer","retryAt":0,"decisionId":"w","configHash":"c","workClass":"L3","reasons":["over_pace"]}'; exit 75\n`);
  await writeFile(sender, `#!/bin/sh\nprintf 'sent\\n' >> '${sends}'\nmkdir '${lock}'\nexit 0\n`);
  await chmod(limen, 0o700); await chmod(sender, 0o700);
  const submitted = await run(["submit", "--state", state, "--limen", limen, "--policy", "policy", "--provider", "codex", "--harness", "codex", "--run-id", "uncertain", "--class", "L3", "--", sender]);
  assert.equal(submitted.code, 75);
  await writeFile(marker, "admit\n");
  const first = await run(["drain", "--state", state, "--now", "1"]);
  assert.equal(first.code, 1);
  assert.match(first.stdout, /dispatch_unknown/);
  await rm(lock, { recursive: true });
  const second = await run(["drain", "--state", state, "--now", "2"]);
  assert.equal(second.code, 0);
  assert.equal((await readFile(sends, "utf8")).trim().split("\n").length, 1);
  const events = await readFile(`${state}.events.ndjson`, "utf8");
  assert.match(events, /dispatch_unknown/);
});

test("invalid Limen protocol never delivers a prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mesh-capacity-"));
  const limen = join(dir, "bad-limen.sh"), sender = join(dir, "send.sh"), sent = join(dir, "sent");
  await writeFile(limen, "#!/bin/sh\necho nope\n"); await writeFile(sender, `#!/bin/sh\ntouch '${sent}'\n`);
  await chmod(limen, 0o700); await chmod(sender, 0o700);
  const result = await run(["submit", "--state", join(dir, "queue.json"), "--limen", limen, "--policy", "policy", "--provider", "codex", "--harness", "codex", "--run-id", "run-bad", "--class", "L3", "--", sender]);
  assert.equal(result.code, 2); await assert.rejects(stat(sent));
});

test("mesh send prefers the additive v2 provider policy before queueing L3 work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mesh-capacity-policy-"));
  const config = join(dir, "config"), state = join(dir, "state"), bin = join(dir, "bin");
  const policy = join(config, "limen", "codex-shadow-policy-v2.json");
  const legacyPolicy = join(config, "limen", "codex-shadow-policy.json");
  const registry = join(dir, "registry.json"), limen = join(bin, "limen"), tmux = join(bin, "tmux");
  const argsFile = join(dir, "limen-args.txt");
  await mkdir(join(config, "limen"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(policy, "{}\n");
  await writeFile(legacyPolicy, "{}\n");
  await writeFile(registry, JSON.stringify({ agents: [{ name: "codex", agent_type: "codex", tmux_target: "mesh-codex-main", status: "online" }] }));
  await writeFile(tmux, "#!/bin/sh\nexit 0\n");
  await writeFile(limen, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\necho '{"decision":"defer","retryAt":0,"decisionId":"defer-L3","configHash":"cfg","workClass":"L3","concurrencyTarget":0,"reasons":["over_pace"]}'\nexit 75\n`);
  await chmod(tmux, 0o700); await chmod(limen, 0o700);
  const result = await runCommand(meshSend, ["--to", "codex", "--class", "L3", "--run-id", "run-auto-policy", "background work"], {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    MESH_REGISTRY: registry,
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: state,
    LIMEN_BIN: limen,
  });
  assert.equal(result.code, 75);
  assert.match(result.stderr, /waiting_capacity/);
  assert.match(await readFile(argsFile, "utf8"), new RegExp(`--config\\n${policy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("mesh send falls back to the legacy provider policy during migration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mesh-capacity-policy-"));
  const config = join(dir, "config"), state = join(dir, "state"), bin = join(dir, "bin");
  const policy = join(config, "limen", "claude-shadow-policy.json");
  const registry = join(dir, "registry.json"), limen = join(bin, "limen"), tmux = join(bin, "tmux");
  const argsFile = join(dir, "limen-args.txt");
  await mkdir(join(config, "limen"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(policy, "{}\n");
  await writeFile(registry, JSON.stringify({ agents: [{ name: "claude", agent_type: "claude", tmux_target: "mesh-claude-main", status: "online" }] }));
  await writeFile(tmux, "#!/bin/sh\nexit 0\n");
  await writeFile(limen, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\necho '{"decision":"defer","retryAt":0,"decisionId":"defer-L2","configHash":"cfg","workClass":"L2","concurrencyTarget":0,"reasons":["over_pace"]}'\nexit 75\n`);
  await chmod(tmux, 0o700); await chmod(limen, 0o700);
  const result = await runCommand(meshSend, ["--to", "claude", "--class", "L2", "--run-id", "run-legacy-policy", "background work"], {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    MESH_REGISTRY: registry,
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: state,
    LIMEN_BIN: limen,
  });
  assert.equal(result.code, 75);
  assert.match(result.stderr, /waiting_capacity/);
  assert.match(await readFile(argsFile, "utf8"), new RegExp(`--config\\n${policy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [dispatcher, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

function runCommand(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
  });
}
