import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../bin/agent-session.sh", import.meta.url).pathname;

test("Claude target ownership requires one unattached live pane and its actual writer", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-claude-owner-"));
  try {
    const bin = join(root, "bin");
    const proc = join(root, "proc");
    mkdirSync(bin);
    for (const [pid, parent] of [[100, 1], [101, 100], [102, 1]]) {
      mkdirSync(join(proc, String(pid)), { recursive: true });
      writeFileSync(join(proc, String(pid), "status"), `Name:\tclaude\nPPid:\t${parent}\n`);
    }
    const tmux = join(bin, "tmux");
    writeFileSync(tmux, "#!/bin/sh\n[ \"$3\" = list-panes ] || exit 2\nprintf '%s\\n' \"$FAKE_PANES\"\n");
    chmodSync(tmux, 0o755);
    const invoke = (writerPid, panes) => spawnSync(script, [
      "--agent", "claude", "target-status", "mesh-claude-example",
      "--writer-pid", String(writerPid), "--json"
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        AGENT_WRITER_PROC_ROOT: proc,
        MESH_TMUX_SOCKET: "owner-fixture",
        FAKE_PANES: panes
      }
    });
    const pane = "mesh-claude-example|100|claude|0|0";
    const accepted = invoke(101, pane);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.deepEqual(JSON.parse(accepted.stdout), {
      target: "mesh-claude-example", pane_pid: 100, writer_pid: 101
    });
    assert.equal(invoke(102, pane).status, 4);
    assert.equal(invoke(101, `${pane}\n${pane}`).status, 4);
    assert.equal(invoke(101, "mesh-claude-example|100|claude|0|1").status, 4);
    assert.equal(invoke(101, "mesh-claude-example|100|bash|0|0").status, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
