import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../bin/claude-transcript-result.mjs", import.meta.url).pathname;
const SESSION = "55555555-5555-4555-8555-555555555555";
const TASK = "mesh_task_long_result";
const token = createHash("sha256").update(TASK).digest("hex").slice(0, 16);

function assistant(text, stop = "end_turn") {
  return JSON.stringify({ type: "assistant", message: { stop_reason: stop, content: [{ type: "text", text }] } });
}

function run(root, wait = "0") {
  return new Promise((resolveRun) => {
    execFile(process.execPath, [script, "--session", SESSION, "--correlation-id", TASK, "--wait", wait, "--root", root], {
      env: { ...process.env, AGENT_TRANSCRIPT_RESULT_POLL_MS: "20" },
      maxBuffer: 10 * 1024 * 1024
    }, (error, stdout, stderr) => resolveRun({ code: error ? error.code : 0, stdout, stderr }));
  });
}

async function fixture(lines) {
  const root = await mkdtemp(join(tmpdir(), "mesh-transcript-result-"));
  const dir = join(root, "-srv-workspaces-example");
  await mkdir(dir, { recursive: true });
  if (lines !== undefined) await writeFile(join(dir, `${SESSION}.jsonl`), `${lines.join("\n")}\n`);
  return { root, dir };
}

test("returns the whole correlated reply even past the pipe buffer", async () => {
  const body = `OVERALL: PASS\n${"finding line\n".repeat(4000)}`;
  const { root } = await fixture([
    assistant("Working on it.", "tool_use"),
    assistant(`Summary first.\n[[R:${token}]]\n${body}\n[[/R:${token}]]`)
  ]);
  try {
    const result = await run(root);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `${body.trim()}\n`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reports a missing result as a timeout and ambiguous markers as a parse failure", async () => {
  const empty = await fixture([assistant("no markers here")]);
  const doubled = await fixture([
    assistant(`[[R:${token}]] a [[/R:${token}]]`),
    assistant(`[[R:${token}]] b [[/R:${token}]]`)
  ]);
  const unterminated = await fixture([assistant(`[[R:${token}]] cut off`)]);
  try {
    assert.equal((await run(empty.root)).code, 124);
    assert.equal((await run(doubled.root)).code, 67);
    assert.equal((await run(unterminated.root)).code, 67);
  } finally {
    for (const item of [empty, doubled, unterminated]) await rm(item.root, { recursive: true, force: true });
  }
});

test("waits for a result that lands in the transcript later", async () => {
  const { root, dir } = await fixture(undefined);
  try {
    const pending = run(root, "5");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    await writeFile(join(dir, `${SESSION}.jsonl`), `${assistant(`[[R:${token}]]late answer[[/R:${token}]]`)}\n`);
    const result = await pending;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "late answer\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
