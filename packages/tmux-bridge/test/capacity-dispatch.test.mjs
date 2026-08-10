import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const dispatcher = new URL("../bin/mesh-capacity-dispatch.mjs", import.meta.url).pathname;

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
});

test("invalid Limen protocol never delivers a prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mesh-capacity-"));
  const limen = join(dir, "bad-limen.sh"), sender = join(dir, "send.sh"), sent = join(dir, "sent");
  await writeFile(limen, "#!/bin/sh\necho nope\n"); await writeFile(sender, `#!/bin/sh\ntouch '${sent}'\n`);
  await chmod(limen, 0o700); await chmod(sender, 0o700);
  const result = await run(["submit", "--state", join(dir, "queue.json"), "--limen", limen, "--policy", "policy", "--provider", "codex", "--harness", "codex", "--run-id", "run-bad", "--class", "L3", "--", sender]);
  assert.equal(result.code, 2); await assert.rejects(stat(sent));
});

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [dispatcher, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
  });
}
