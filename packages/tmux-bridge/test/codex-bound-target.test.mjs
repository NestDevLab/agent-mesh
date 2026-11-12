import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, symlink, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../bin/agent-session.sh", import.meta.url).pathname;

test("bound Codex pane permits attached observers while preserving ancestry and cwd proof", async t => {
  const root = await mkdtemp(join(tmpdir(), "mesh-bound-target-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin"), proc = join(root, "proc"), cwd = join(root, "workspace");
  await mkdir(bin); await mkdir(cwd);
  await mkdir(join(proc, "101"), { recursive: true });
  await writeFile(join(proc, "101/status"), "PPid:\t100\n");
  await symlink(cwd, join(proc, "101/cwd"));
  await writeFile(join(bin, "tmux"), '#!/bin/sh\nprintf "%s\\n" "$FAKE_PANES"\n', { mode: 0o755 });
  const invoke = (panes, extra = [], writer = "101") => spawnSync(script, [
    "--agent", "codex", "target-status", "owned", "--writer-pid", writer, "--json", ...extra
  ], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: root,
    CODEX_NO_REMOTE: "1", MESH_GRAPH_DISABLE: "1", AGENT_WRITER_PROC_ROOT: proc,
    MESH_TMUX_SOCKET: "bound-fixture", FAKE_PANES: panes } });
  const attached = "owned|100|codex|0|1";
  assert.equal(invoke(attached).status, 4); // creation/default remains unattended
  const flags = ["--allow-attached", "--owned-cwd", cwd];
  const accepted = invoke(attached, flags);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).pane_pid, 100);
  assert.equal(invoke("owned|100|codex|0|0", flags).status, 0);
  assert.equal(invoke(attached, flags, "102").status, 4);
  assert.equal(invoke(`${attached}\n${attached}`, flags).status, 4);
  assert.equal(invoke("owned|100|bash|0|1", flags).status, 4);
  assert.equal(invoke("owned|100|codex|1|1", flags).status, 4);
  assert.equal(invoke(attached, ["--allow-attached", "--owned-cwd", root]).status, 5);
  assert.equal(invoke("owned|200|codex|0|1", [...flags, "--pane-pid", "100"]).status, 5);
  await writeFile(join(proc, "101/status"), "PPid:\t1\n");
  assert.equal(invoke(attached, [...flags, "--pane-pid", "100"]).status, 5);
  await writeFile(join(proc, "101/status"), "Name:\tmissing-parent\n");
  assert.equal(invoke(attached, [...flags, "--pane-pid", "100"]).status, 4);
  await writeFile(join(proc, "101/status"), "PPid:\t100\n");
  await unlink(join(proc, "101/cwd"));
  assert.equal(invoke(attached, flags).status, 4); // missing observation is not a changed cwd
});
