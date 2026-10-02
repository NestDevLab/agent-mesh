import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { deploymentPlan, installDeployment } from "../scripts/install-systemd.mjs";

const options = { uid: process.getuid() || 1000, gid: process.getgid() || 1000, directoriesOnly: true };
const available = spawnSync("systemd-tmpfiles", ["--version"]).status === 0;

test("CLI plans without writes and checks applied standalone files", { skip: !available }, () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-systemd-cli-"));
  try {
    const installer = fileURLToPath(new URL("../scripts/install-systemd.mjs", import.meta.url));
    // Releases are commonly invoked through an atomic current symlink.
    const current = join(root, "current");
    symlinkSync(installer, current);
    const args = [current, "--uid", String(options.uid), "--gid", String(options.gid), "--root", root];
    const planned = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(planned.status, 0, planned.stderr);
    assert.equal(JSON.parse(planned.stdout).uid, options.uid);
    assert.equal(existsSync(join(root, "etc")), false);
    assert.equal(spawnSync(process.execPath, [...args, "--check"]).status, 1);
    const applied = spawnSync(process.execPath, [...args, "--apply"], { encoding: "utf8" });
    assert.equal(applied.status, 0, applied.stderr);
    const checked = spawnSync(process.execPath, [...args, "--check"], { encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /deployment matches/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("standalone service and runtime rules are configurable without a fleet", () => {
  const plan = deploymentPlan({ uid: 1201, gid: 1202, releaseDir: "/opt/example/mesh", config: "/etc/example/config.json", writePaths: ["/home/example/.codex"] });
  assert.match(plan.files[0].content, /d \/tmp\/agent-mesh-1201 0700 1201 1202 -/);
  assert.match(plan.files[0].content, /d \/tmp\/tmux-1201 0700 1201 1202 -/);
  const unit = plan.files[1].content;
  assert.match(unit, /Requires=systemd-tmpfiles-setup.service/);
  assert.match(unit, /WorkingDirectory=\/opt\/example\/mesh/);
  assert.match(unit, /User=1201\nGroup=1202/);
  assert.match(unit, /\/home\/example\/\.codex/);
  assert.doesNotMatch(unit, /@[A-Z_]+@|fleet-control/);
});

test("invalid IDs, broad temporary paths and systemd specifiers fail closed", () => {
  for (const extra of [{ uid: 0 }, { gid: -1 }, { bridgeDir: "/tmp" }, { bridgeDir: "/tmp/../etc" }, { bridgeDir: "/tmp/a%u" }, { bridgeDir: "/tmp/one two" }, { tmuxDir: `/tmp/agent-mesh-${options.uid}` }]) {
    assert.throws(() => deploymentPlan({ ...options, ...extra }));
  }
});

test("actual tmpfiles boot recreates missing directories and preserves permissions", { skip: !available }, () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-systemd-test-"));
  try {
    const plan = deploymentPlan(options);
    // Model this host's D /tmp boot cleanup in an isolated filesystem only.
    mkdirSync(join(root, "usr/lib/tmpfiles.d"), { recursive: true });
    writeFileSync(join(root, "usr/lib/tmpfiles.d/tmp.conf"), `D /tmp 1777 ${process.getuid()} ${process.getgid()} 30d\n`);
    installDeployment(plan, root);
    const state = join(root, plan.bridgeDir, "test-state");
    writeFileSync(state, "survive ordinary cleanup");
    // Repeated installation must not remove live files or sockets.
    installDeployment(plan, root);
    assert.equal(readFileSync(state, "utf8"), "survive ordinary cleanup");
    writeFileSync(join(root, "usr/lib/tmpfiles.d/tmp.conf"), `D /tmp 1777 ${process.getuid()} ${process.getgid()} 0\n`);
    execFileSync("systemd-tmpfiles", ["--root", root, "--clean"], { stdio: "pipe" });
    assert.equal(readFileSync(state, "utf8"), "survive ordinary cleanup");
    for (const path of [plan.bridgeDir, plan.tmuxDir]) rmSync(join(root, path), { recursive: true });
    assert.equal(existsSync(join(root, plan.bridgeDir)), false);
    execFileSync("systemd-tmpfiles", ["--root", root, "--remove", "--create", "--boot"], { stdio: "pipe" });
    for (const path of [plan.bridgeDir, plan.tmuxDir]) {
      const stat = lstatSync(join(root, path));
      assert.equal(stat.mode & 0o777, 0o700);
      assert.equal(stat.uid, Number(options.uid));
      assert.equal(stat.gid, Number(options.gid));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("installer refuses a symlink before writing persistent configuration", { skip: !available }, () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-systemd-symlink-"));
  try {
    const plan = deploymentPlan(options);
    mkdirSync(join(root, "tmp"));
    symlinkSync("/etc", join(root, plan.bridgeDir));
    assert.throws(() => installDeployment(plan, root), /Refusing unsafe/);
    assert.equal(existsSync(join(root, plan.rulePath)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
