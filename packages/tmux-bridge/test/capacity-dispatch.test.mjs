import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const dispatcher = new URL("../bin/mesh-capacity-dispatch.mjs", import.meta.url).pathname;
const meshSend = new URL("../bin/mesh-send.sh", import.meta.url).pathname;
const sessionBin = new URL("../bin/agent-session.sh", import.meta.url).pathname;
const spawnBin = new URL("../bin/agent-spawn.sh", import.meta.url).pathname;

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

test("session admission requires exactly one complete routing form", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mesh-capacity-parse-"));
  const common = ["submit", "--state", join(dir, "queue.json"), "--policy", "policy", "--provider", "codex", "--harness", "codex", "--run-id", "parse", "--class", "L2", "--lifecycle", "session", "--session", "session", "--target", "target"];
  try {
    for (const route of [
      ["--profile", "profile", "--model", "model", "--effort", "high"],
      ["--model", "model"],
      ["--effort", "high"],
      [],
    ]) {
      const result = await run([...common, ...route, "--", "true"]);
      assert.equal(result.code, 2, `${route.join(" ")} should be rejected`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("exact model and effort admission preserves native binding and session lifecycle without top-level provider", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mesh-capacity-exact-"));
  const state = join(dir, "queue.json"), limen = join(dir, "fake-limen.sh"), launcher = join(dir, "fake-launch.sh");
  const seenArgs = join(dir, "limen-args.txt"), seenRoute = join(dir, "route.json"), target = `mesh-exact-gone-${process.pid}`;
  await writeFile(limen, `#!/bin/sh
printf '%s\\n' "$@" >> '${seenArgs}'
if [ "$1" = admit ]; then
  echo '{"decision":"admit","model":"requested-model","nativeModel":"native-model","effort":"high","decisionId":"exact-1","configHash":"cfg","lease":{"expiresAt":999,"candidate":{"key":"0123456789abcdef0123456789abcdef","model":"requested-model","nativeModel":"native-model","effort":"high","capacityCostBase":null}}}'
  exit 0
fi
if [ "$1" = complete ]; then echo '{"status":"completed"}'; exit 0; fi
exit 2
`);
  await writeFile(launcher, `#!/bin/sh
printf '%s\\n' "$MESH_LIMEN_ROUTE" > '${seenRoute}'
exit 0
`);
  await chmod(limen, 0o700); await chmod(launcher, 0o700);
  try {
    const result = await run(["submit", "--state", state, "--limen", limen, "--policy", "policy", "--provider", "codex", "--harness", "codex", "--run-id", "exact-run", "--class", "L2", "--lifecycle", "session", "--session", "exact-session", "--target", target, "--model", "requested-model", "--effort", "high", "--", launcher]);
    assert.equal(result.code, 0, result.stderr);
    const args = await readFile(seenArgs, "utf8");
    assert.match(args, /--model\nrequested-model/);
    assert.match(args, /--effort\nhigh/);
    const route = JSON.parse(await readFile(seenRoute, "utf8"));
    assert.equal(route.nativeModel, "native-model");
    assert.equal(route.model, "requested-model");
    assert.deepEqual(route.candidate, { key: "0123456789abcdef0123456789abcdef", model: "requested-model", nativeModel: "native-model", effort: "high", capacityCostBase: null });
    const ledger = JSON.parse(await readFile(state, "utf8"));
    assert.equal(ledger.sessions[0].status, "completed");
    assert.equal(ledger.sessions[0].provider, "codex");
    assert.equal(ledger.sessions[0].nativeModel, "native-model");
    assert.equal(ledger.sessions[0].effort, "high");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an explicit exact-session defer waits instead of launching", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mesh-capacity-exact-wait-"));
  const state = join(dir, "queue.json"), limen = join(dir, "fake-limen.sh"), marker = join(dir, "launched");
  const launcher = join(dir, "launcher.sh");
  await writeFile(limen, `#!/bin/sh
echo '{"decision":"defer","provider":"codex","model":"requested-model","nativeModel":"native-model","effort":"high","state":"over_pace","retryAt":123,"decisionId":"defer-1","configHash":"cfg","reasons":["over_pace"]}'
exit 75
`);
  await writeFile(launcher, `#!/bin/sh
touch '${marker}'
`);
  await chmod(limen, 0o700); await chmod(launcher, 0o700);
  try {
    const result = await run(["submit", "--state", state, "--limen", limen, "--policy", "policy", "--provider", "codex", "--harness", "codex", "--run-id", "exact-wait", "--class", "L2", "--lifecycle", "session", "--session", "exact-wait", "--target", "target", "--model", "requested-model", "--effort", "high", "--", launcher]);
    assert.equal(result.code, 75, result.stderr);
    assert.match(result.stderr, /waiting_capacity/);
    await assert.rejects(stat(marker));
    const ledger = JSON.parse(await readFile(state, "utf8"));
    assert.equal(ledger.jobs[0].status, "waiting_capacity");
    assert.equal(ledger.jobs[0].options.lifecycle, "session");
    assert.equal(ledger.sessions.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("force overrides only a soft exact defer and leaves the session unleased", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mesh-capacity-force-"));
  const state = join(dir, "queue.json"), limen = join(dir, "fake-limen.sh"), launcher = join(dir, "launcher.sh");
  const commands = join(dir, "limen-commands.txt"), route = join(dir, "route.json");
  await writeFile(limen, `#!/bin/sh
printf '%s\\n' "$1" >> '${commands}'
if [ "$1" = admit ]; then
  echo '{"decision":"defer","provider":"codex","model":"requested-model","nativeModel":"native-model","effort":"high","state":"over_pace","retryAt":123,"decisionId":"defer-force","configHash":"cfg","reasons":["over_pace"],"candidate":{"key":"0123456789abcdef0123456789abcdef","model":"requested-model","nativeModel":"native-model","effort":"high","capacityCostBase":null}}'
  exit 75
fi
exit 2
`);
  await writeFile(launcher, `#!/bin/sh
printf '%s\\n' "$MESH_LIMEN_ROUTE" > '${route}'
exit 0
`);
  await chmod(limen, 0o700); await chmod(launcher, 0o700);
  try {
    const result = await run(["submit", "--state", state, "--limen", limen, "--policy", "policy", "--provider", "codex", "--harness", "codex", "--run-id", "forced-run", "--class", "L2", "--lifecycle", "session", "--session", "forced-session", "--target", `mesh-force-gone-${process.pid}`, "--model", "requested-model", "--effort", "high", "--force", "--", launcher]);
    assert.equal(result.code, 0, result.stderr);
    const routed = JSON.parse(await readFile(route, "utf8"));
    assert.equal(routed.unleased, true);
    assert.equal(routed.nativeModel, "native-model");
    assert.equal(routed.effort, "high");
    assert.equal("candidate" in routed, false, "an override must not manufacture a lease");
    const ledger = JSON.parse(await readFile(state, "utf8"));
    assert.equal(ledger.sessions[0].status, "completed");
    assert.equal(ledger.sessions[0].unleased, true);
    assert.equal("leased" in ledger.sessions[0], false);
    assert.equal("candidate" in ledger.sessions[0], false);
    const events = (await readFile(`${state}.events.ndjson`, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const overridden = events.find(event => event.status === "capacity_overridden");
    assert.deepEqual(overridden.requestedCandidate, { provider: "codex", model: "requested-model", nativeModel: "native-model", effort: "high" });
    assert.equal(overridden.originalDefer.decision, "defer");
    assert.equal("lease" in overridden.originalDefer, false);
    assert.deepEqual((await readFile(commands, "utf8")).trim().split("\n"), ["admit"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("force rejects hard and incomplete Limen defers without launching", async () => {
  for (const mode of ["hard", "incomplete"]) {
    const dir = await mkdtemp(join(tmpdir(), `mesh-capacity-force-${mode}-`));
    const state = join(dir, "queue.json"), limen = join(dir, "fake-limen.sh"), marker = join(dir, "launched"), launcher = join(dir, "launcher.sh");
    const response = mode === "hard"
      ? { decision: "defer", provider: "codex", model: "requested-model", nativeModel: "native-model", effort: "high", state: "policy_denied", reasons: ["policy_denied"] }
      : { decision: "defer", provider: "codex", model: "requested-model", effort: "high", state: "over_pace", reasons: ["over_pace"] };
    await writeFile(limen, `#!/bin/sh
echo '${JSON.stringify(response)}'
exit 75
`);
    await writeFile(launcher, `#!/bin/sh
touch '${marker}'
`);
    await chmod(limen, 0o700); await chmod(launcher, 0o700);
    try {
      const result = await run(["submit", "--state", state, "--limen", limen, "--policy", "policy", "--provider", "codex", "--harness", "codex", "--run-id", `force-${mode}`, "--class", "L2", "--lifecycle", "session", "--session", `force-${mode}`, "--target", `mesh-force-${mode}-${process.pid}`, "--model", "requested-model", "--effort", "high", "--force", "--", launcher]);
      assert.equal(result.code, 2, `${mode} defer must not be forced`);
      await assert.rejects(stat(marker));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("completion preserves the admission session lineage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mesh-capacity-session-"));
  const state = join(dir, "queue.json"), argsFile = join(dir, "complete-args.txt");
  const limen = join(dir, "fake-limen.sh"), sender = join(dir, "fake-send.sh");
  await writeFile(limen, `#!/bin/sh\nif [ "$1" = complete ]; then printf '%s\\n' "$@" > '${argsFile}'; echo '{"status":"completed"}'; exit 0; fi\necho '{"decision":"admit","retryAt":null,"decisionId":"d","configHash":"c","workClass":"L2","concurrencyTarget":1,"reasons":["available"]}'\n`);
  await writeFile(sender, "#!/bin/sh\nexit 0\n");
  await chmod(limen, 0o700); await chmod(sender, 0o700);
  const result = await run(["submit", "--state", state, "--limen", limen, "--policy", "policy", "--provider", "codex", "--harness", "codex", "--run-id", "private-run", "--class", "L2", "--session", "session-1", "--", sender]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(await readFile(argsFile, "utf8"), /--session\nsession-1/);
  const events = await readFile(`${state}.events.ndjson`, "utf8");
  assert.doesNotMatch(events, /private-run|session-1/);
});

test("profile routing records a candidate lease and closes a disappeared session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mesh-capacity-route-"));
  const state = join(dir, "queue.json"), seenRoute = join(dir, "route.json");
  const limen = join(dir, "fake-limen.sh"), launcher = join(dir, "fake-launch.sh");
  await writeFile(limen, `#!/bin/sh
if [ "$1" = route ]; then
  printf '%s\\n' "$@" > '${seenRoute}'
  echo '{"decision":"route","provider":"codex","model":"gpt-5.6-terra","nativeModel":"gpt-5.6-terra","effort":"high","decisionId":"route-1","configHash":"cfg","lease":{"expiresAt":999,"candidate":{"key":"0123456789abcdef0123456789abcdef","model":"gpt-5.6-terra","effort":"high","capacityCostBase":null}}}'
  exit 0
fi
if [ "$1" = renew ]; then echo '{"status":"renewed","expiresAt":999}'; exit 0; fi
if [ "$1" = complete ]; then echo '{"status":"completed","candidate":{"key":"0123456789abcdef0123456789abcdef","model":"gpt-5.6-terra","effort":"high","capacityCostBase":null}}'; exit 0; fi
exit 2
`);
  await writeFile(launcher, `#!/bin/sh
node -e 'const r=JSON.parse(process.env.MESH_LIMEN_ROUTE); if (r.model !== "gpt-5.6-terra" || r.nativeModel !== "gpt-5.6-terra" || r.effort !== "high") process.exit(2)'
`);
  await chmod(limen, 0o700); await chmod(launcher, 0o700);
  const result = await run(["submit", "--state", state, "--limen", limen, "--policy", "policy", "--provider", "codex", "--harness", "codex", "--run-id", "session-run", "--class", "L2", "--profile", "implementation.spec-defined", "--lifecycle", "session", "--session", "mesh-gone", "--target", "mesh-gone", "--renew-ms", "10", "--", launcher]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(await readFile(seenRoute, "utf8"), /--profile\nimplementation\.spec-defined/);
  await new Promise(resolve => setTimeout(resolve, 200));
  const ledger = JSON.parse(await readFile(state, "utf8"));
  assert.deepEqual(ledger.sessions[0].candidate, { key: "0123456789abcdef0123456789abcdef", model: "gpt-5.6-terra", effort: "high", capacityCostBase: null });
  assert.equal(ledger.sessions[0].status, "completed");
  const events = await readFile(`${state}.events.ndjson`, "utf8");
  assert.match(events, /session_active/);
  assert.match(events, /"completed"/);
  assert.match(events, /capacityCostBase/);
});

test("agent-spawn uses a routed native rendering and closes its lease after the agent process disappears", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mesh-session-route-"));
  const bin = join(dir, "bin"), agents = join(dir, "agents"), state = join(dir, "queue.json"), limen = join(bin, "limen"), codex = join(bin, "fake-codex"), launchArgs = join(dir, "codex-args.txt");
  const socket = `mesh-route-${process.pid}-${Date.now()}`;
  const target = `mesh-codex-route-${process.pid}`;
  await mkdir(bin); await mkdir(agents);
  await writeFile(limen, `#!/bin/sh\nif [ "$1" = route ]; then echo '{"decision":"route","provider":"codex","model":"governed-model","nativeModel":"native-model","effort":"high","decisionId":"route-1","configHash":"cfg","lease":{"expiresAt":999,"candidate":{"key":"0123456789abcdef0123456789abcdef","model":"governed-model","effort":"high","capacityCostBase":null}}}'; exit 0; fi\nif [ "$1" = renew ]; then echo '{"status":"renewed","expiresAt":999}'; exit 0; fi\nif [ "$1" = complete ]; then echo '{"status":"completed","candidate":{"key":"0123456789abcdef0123456789abcdef","model":"governed-model","effort":"high","capacityCostBase":null}}'; exit 0; fi\nexit 2\n`);
  await writeFile(join(agents, "codex.conf"), `AGENT_BIN="fake-codex"\nAGENT_ALIVE_PROCESS_PATTERN="^(fake-codex|sleep)$"\nAGENT_SUBMIT_KEY="Enter"\nAGENT_PROMPT_CHAR="FAKE>"\nAGENT_WORKING_PATTERN="WORKING"\nAGENT_IDLE_PATTERN="FAKE>"\nAGENT_RESUME_CMD="fake-codex"\nAGENT_HAS_CWD_PICKER="false"\nAGENT_PICKER_PATTERN=""\nAGENT_NEW_CMD="fake-codex"\nAGENT_SESSION_DIR="${dir}"\nAGENT_SESSION_CWD_EXTRACTOR='printf "?\\n"'\nAGENT_SUPPORTS_MODEL="true"\nAGENT_MODEL_ARGS=(--model "{VALUE}")\nAGENT_MODEL_PASSTHRU_PATTERNS=()\nAGENT_SUPPORTS_EFFORT="true"\nAGENT_EFFORT_ARGS=(--effort "{VALUE}")\nAGENT_EFFORT_PASSTHRU_PATTERNS=()\n`);
  await writeFile(codex, `#!/bin/sh\nprintf '%s\\n' "$*" > '${launchArgs}'\nprintf 'FAKE>\\n'\nsleep 2\n`);
  await chmod(limen, 0o700); await chmod(codex, 0o700);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, LIMEN_BIN: limen, MESH_CAPACITY_STATE: state, MESH_TMUX_SOCKET: socket, MESH_LEASE_RENEW_MS: "10", AGENT_MESH_AGENTS_DIR: agents };
  try {
    const launched = await runCommand(spawnBin, ["--agent", "codex", "--profile", "implementation.spec-defined", "--limen-config", "policy", "new", dir, target], env);
    assert.equal(launched.code, 0, launched.stderr);
    assert.equal(launched.stdout.trim(), target);
    await waitFor(async () => (await readFile(launchArgs, "utf8")).length > 0);
    assert.match(await readFile(launchArgs, "utf8"), /--model native-model/);
    assert.match(await readFile(launchArgs, "utf8"), /--effort high/);
    const opened = JSON.parse(await readFile(state, "utf8"));
    assert.deepEqual(opened.sessions[0].candidate, { key: "0123456789abcdef0123456789abcdef", model: "governed-model", effort: "high", capacityCostBase: null });
    await waitFor(async () => (await readFile(`${state}.events.ndjson`, "utf8")).includes("lease_renewed"));
    await waitFor(async () => JSON.parse(await readFile(state, "utf8")).sessions[0]?.status === "completed", 3_000);
    assert.equal((await runCommand("tmux", ["-L", socket, "has-session", "-t", target], env)).code, 0, "the tmux shell remains after the agent process exits");
    const events = await readFile(`${state}.events.ndjson`, "utf8");
    assert.match(events, /session_active/);
    assert.match(events, /"completed"/);
  } finally {
    await runCommand("tmux", ["-L", socket, "kill-server"], env);
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude keeps an unsupported effort as route metadata without passing a fake effort flag", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mesh-session-claude-exact-"));
  const bin = join(dir, "bin"), agents = join(dir, "agents"), state = join(dir, "queue.json"), limen = join(bin, "limen"), claude = join(bin, "fake-claude");
  const launchArgs = join(dir, "claude-args.txt"), routeFile = join(dir, "claude-route.json");
  const socket = `mesh-claude-exact-${process.pid}-${Date.now()}`, target = `mesh-claude-exact-${process.pid}`;
  await mkdir(bin); await mkdir(agents);
  await writeFile(limen, `#!/bin/sh
if [ "$1" = admit ]; then echo '{"decision":"admit","provider":"claude","model":"requested-model","nativeModel":"native-claude","effort":"high","decisionId":"claude-exact-1","configHash":"cfg","lease":{"expiresAt":999,"candidate":{"key":"0123456789abcdef0123456789abcdef","model":"requested-model","nativeModel":"native-claude","effort":"high","capacityCostBase":null}}}'; exit 0; fi
if [ "$1" = renew ]; then echo '{"status":"renewed","expiresAt":999}'; exit 0; fi
if [ "$1" = complete ]; then echo '{"status":"completed"}'; exit 0; fi
exit 2
`);
  await writeFile(join(agents, "claude.conf"), `AGENT_BIN="fake-claude"
AGENT_ALIVE_PROCESS_PATTERN="^(fake-claude|sleep)$"
AGENT_SUBMIT_KEY="Enter"
AGENT_PROMPT_CHAR="FAKE>"
AGENT_WORKING_PATTERN="WORKING"
AGENT_IDLE_PATTERN="FAKE>"
AGENT_RESUME_CMD="fake-claude"
AGENT_HAS_CWD_PICKER="false"
AGENT_PICKER_PATTERN=""
AGENT_NEW_CMD="fake-claude"
AGENT_SESSION_DIR="${dir}"
AGENT_SESSION_CWD_EXTRACTOR='printf "?\\n"'
AGENT_SUPPORTS_MODEL="true"
AGENT_MODEL_ARGS=(--model "{VALUE}")
AGENT_MODEL_PASSTHRU_PATTERNS=()
AGENT_SUPPORTS_EFFORT="false"
AGENT_EFFORT_ARGS=()
AGENT_EFFORT_PASSTHRU_PATTERNS=()
`);
  await writeFile(claude, `#!/bin/sh
printf '%s\\n' "$*" > '${launchArgs}'
printf '%s\\n' "$MESH_LIMEN_ROUTE" > '${routeFile}'
printf 'FAKE>\\n'
sleep 0.5
`);
  await chmod(limen, 0o700); await chmod(claude, 0o700);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, LIMEN_BIN: limen, MESH_CAPACITY_STATE: state, MESH_TMUX_SOCKET: socket, MESH_LEASE_RENEW_MS: "20", AGENT_MESH_AGENTS_DIR: agents };
  try {
    const launched = await runCommand(spawnBin, ["--agent", "claude", "--model", "requested-model", "--effort", "high", "--limen-config", "policy", "new", dir, target], env);
    assert.equal(launched.code, 0, launched.stderr);
    assert.equal(launched.stdout.trim(), target);
    await waitFor(async () => (await readFile(launchArgs, "utf8")).length > 0);
    assert.match(await readFile(launchArgs, "utf8"), /--model native-claude/);
    assert.doesNotMatch(await readFile(launchArgs, "utf8"), /--effort/);
    const route = JSON.parse(await readFile(routeFile, "utf8"));
    assert.equal(route.effort, "high");
    assert.equal(route.nativeModel, "native-claude");
    await waitFor(async () => JSON.parse(await readFile(state, "utf8")).sessions[0]?.status === "completed", 3_000);
  } finally {
    await runCommand("tmux", ["-L", socket, "kill-server"], env);
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent-session remains fail-open when Limen is unavailable before launch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mesh-session-fail-open-"));
  const bin = join(dir, "bin"), agents = join(dir, "agents"), launchArgs = join(dir, "codex-args.txt");
  const socket = `mesh-fail-open-${process.pid}-${Date.now()}`;
  const target = `mesh-codex-fail-open-${process.pid}`;
  await mkdir(bin); await mkdir(agents);
  await writeFile(join(agents, "codex.conf"), `AGENT_BIN="fake-codex"\nAGENT_SUBMIT_KEY="Enter"\nAGENT_PROMPT_CHAR="FAKE>"\nAGENT_WORKING_PATTERN="WORKING"\nAGENT_IDLE_PATTERN="FAKE>"\nAGENT_RESUME_CMD="fake-codex"\nAGENT_HAS_CWD_PICKER="false"\nAGENT_PICKER_PATTERN=""\nAGENT_NEW_CMD="fake-codex"\nAGENT_SESSION_DIR="${dir}"\nAGENT_SUPPORTS_MODEL="true"\nAGENT_MODEL_ARGS=(--model "{VALUE}")\nAGENT_MODEL_PASSTHRU_PATTERNS=()\nAGENT_SUPPORTS_EFFORT="true"\nAGENT_EFFORT_ARGS=(--effort "{VALUE}")\nAGENT_EFFORT_PASSTHRU_PATTERNS=()\n`);
  const codex = join(bin, "fake-codex");
  await writeFile(codex, `#!/bin/sh\nprintf '%s|%s\\n' "$*" "\${MESH_LIMEN_ROUTE:-}" > '${launchArgs}'\nprintf 'FAKE>\\n'\nsleep 2\n`);
  await chmod(codex, 0o700);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, LIMEN_BIN: join(bin, "missing-limen"), MESH_TMUX_SOCKET: socket, AGENT_MESH_AGENTS_DIR: agents };
  try {
    const launched = await runCommand(sessionBin, ["--agent", "codex", "--profile", "implementation.spec-defined", "--limen-config", "policy", "new", dir, target], env);
    assert.equal(launched.code, 0, launched.stderr);
    assert.equal(launched.stdout.trim(), target);
    assert.match(launched.stderr, /Limen governed launch unavailable/);
    await waitFor(async () => (await readFile(launchArgs, "utf8")).length > 0);
    assert.doesNotMatch(await readFile(launchArgs, "utf8"), /\{\"provider\"/);
  } finally {
    await runCommand("tmux", ["-L", socket, "kill-server"], env);
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent-session fails closed on Limen hard rejection with and without force", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mesh-session-hard-reject-"));
  const bin = join(dir, "bin"), agents = join(dir, "agents"), limen = join(bin, "limen"), launchArgs = join(dir, "launched");
  const socket = `mesh-hard-reject-${process.pid}-${Date.now()}`;
  await mkdir(bin); await mkdir(agents);
  await writeFile(limen, `#!/bin/sh
if [ "$1" = route ]; then echo invalid-payload; exit 0; fi
if [ "$1" = admit ]; then echo policy-rejected >&2; exit 2; fi
exit 2
`);
  const codex = join(bin, "fake-codex");
  await writeFile(codex, `#!/bin/sh
touch '${launchArgs}'
`);
  await writeFile(join(agents, "codex.conf"), `AGENT_BIN="fake-codex"
AGENT_SUBMIT_KEY="Enter"
AGENT_PROMPT_CHAR="FAKE>"
AGENT_WORKING_PATTERN="WORKING"
AGENT_IDLE_PATTERN="FAKE>"
AGENT_RESUME_CMD="fake-codex"
AGENT_HAS_CWD_PICKER="false"
AGENT_PICKER_PATTERN=""
AGENT_NEW_CMD="fake-codex"
AGENT_SESSION_DIR="${dir}"
AGENT_SUPPORTS_MODEL="true"
AGENT_MODEL_ARGS=(--model "{VALUE}")
AGENT_MODEL_PASSTHRU_PATTERNS=()
AGENT_SUPPORTS_EFFORT="true"
AGENT_EFFORT_ARGS=(--effort "{VALUE}")
AGENT_EFFORT_PASSTHRU_PATTERNS=()
`);
  await chmod(limen, 0o700); await chmod(codex, 0o700);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, LIMEN_BIN: limen, MESH_TMUX_SOCKET: socket, AGENT_MESH_AGENTS_DIR: agents };
  try {
    const rejectedPayload = await runCommand(sessionBin, ["--agent", "codex", "--profile", "implementation.spec-defined", "--limen-config", "policy", "new", dir, `mesh-hard-payload-${process.pid}`], env);
    assert.equal(rejectedPayload.code, 2, rejectedPayload.stderr);
    assert.match(rejectedPayload.stderr, /no session was launched/);
    await assert.rejects(stat(launchArgs));

    const rejectedPolicy = await runCommand(sessionBin, ["--agent", "codex", "--model", "gpt-5.6-luna", "--effort", "xhigh", "--force", "--limen-config", "policy", "new", dir, `mesh-hard-policy-${process.pid}`], env);
    assert.equal(rejectedPolicy.code, 2, rejectedPolicy.stderr);
    assert.match(rejectedPolicy.stderr, /no override was launched/);
    await assert.rejects(stat(launchArgs));
  } finally {
    await runCommand("tmux", ["-L", socket, "kill-server"], env);
    await rm(dir, { recursive: true, force: true });
  }
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

test("mesh send prefers the dedicated broker policy before queueing L3 work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mesh-capacity-policy-"));
  const config = join(dir, "config"), state = join(dir, "state"), bin = join(dir, "bin");
  const policy = join(config, "limen", "codex-broker-policy-v2.json");
  const shadowPolicy = join(config, "limen", "codex-shadow-policy-v2.json");
  const legacyPolicy = join(config, "limen", "codex-shadow-policy.json");
  const registry = join(dir, "registry.json"), limen = join(bin, "limen"), tmux = join(bin, "tmux");
  const argsFile = join(dir, "limen-args.txt");
  await mkdir(join(config, "limen"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(policy, "{}\n");
  await writeFile(shadowPolicy, "{}\n");
  await writeFile(legacyPolicy, "{}\n");
  await writeFile(registry, JSON.stringify({ agents: [{ name: "codex", agent_type: "codex", tmux_target: "mesh-codex-main", status: "online" }] }));
  await writeFile(tmux, "#!/bin/sh\nexit 0\n");
  await writeFile(limen, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\necho '{"decision":"defer","retryAt":0,"decisionId":"defer-L3","configHash":"cfg","workClass":"L3","concurrencyTarget":0,"reasons":["over_pace"]}'\nexit 75\n`);
  await chmod(tmux, 0o700); await chmod(limen, 0o700);
  const result = await runCommand(meshSend, ["--to", "codex", "--class", "L3", "--run-id", "run-auto-policy", "--profile", "implementation.spec-defined", "background work"], {
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

test("mesh send falls back to the additive v2 shadow policy during migration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mesh-capacity-policy-"));
  const config = join(dir, "config"), state = join(dir, "state"), bin = join(dir, "bin");
  const policy = join(config, "limen", "claude-shadow-policy-v2.json");
  const legacyPolicy = join(config, "limen", "claude-shadow-policy.json");
  const registry = join(dir, "registry.json"), limen = join(bin, "limen"), tmux = join(bin, "tmux");
  const argsFile = join(dir, "limen-args.txt");
  await mkdir(join(config, "limen"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(policy, "{}\n");
  await writeFile(legacyPolicy, "{}\n");
  await writeFile(registry, JSON.stringify({ agents: [{ name: "claude", agent_type: "claude", tmux_target: "mesh-claude-main", status: "online" }] }));
  await writeFile(tmux, "#!/bin/sh\nexit 0\n");
  await writeFile(limen, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\necho '{"decision":"defer","retryAt":0,"decisionId":"defer-L2","configHash":"cfg","workClass":"L2","concurrencyTarget":0,"reasons":["over_pace"]}'\nexit 75\n`);
  await chmod(tmux, 0o700); await chmod(limen, 0o700);
  const result = await runCommand(meshSend, ["--to", "claude", "--class", "L2", "--run-id", "run-v2-shadow-policy", "--profile", "implementation.spec-defined", "background work"], {
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
  const result = await runCommand(meshSend, ["--to", "claude", "--class", "L2", "--run-id", "run-legacy-policy", "--profile", "implementation.spec-defined", "background work"], {
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

async function waitFor(check, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for session lifecycle update");
}
