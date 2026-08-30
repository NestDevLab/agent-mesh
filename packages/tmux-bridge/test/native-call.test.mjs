import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const nativeCall = join(packageRoot, "bin", "agent-native-call.mjs");
const sessionId = "66666666-6666-4666-8666-666666666666";

async function fixture(mode = "success") {
  const root = await mkdtemp(join(tmpdir(), "mesh-native-call-"));
  const transcript = join(root, "sessions", `rollout-${sessionId}.jsonl`);
  await mkdir(dirname(transcript), { recursive: true });
  await writeFile(transcript, JSON.stringify({ type: "session_meta", payload: { id: sessionId } }) + "\n");
  const codex = join(root, "fake-codex.mjs");
  await writeFile(codex, `#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
const args = process.argv.slice(2);
const message = args[args.indexOf("--message") + 1];
const anchor = message.match(/\\[MESH:[^\\]]+\\]/)?.[0];
const begin = message.match(/\\[\\[R:[^\\]]+\\]\\]/)?.[0];
const end = message.match(/\\[\\[\\/R:[^\\]]+\\]\\]/)?.[0];
const lines = [];
lines.push({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "stale" }] } });
lines.push({ type: "event_msg", payload: { type: "task_complete" } });
if (${JSON.stringify(mode)} !== "uncorrelated") lines.push({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: anchor }] } });
if (${JSON.stringify(mode)} === "success") lines.push({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: begin + " MULTI\\nLINE " + end }] } });
if (${JSON.stringify(mode)} === "fallback") lines.push({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "MESH_CORRELATION_OK" }] } });
if (${JSON.stringify(mode)} === "uncorrelated") lines.push({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "plain output" }] } });
if (${JSON.stringify(mode)} === "parsing") lines.push({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: begin + " broken" }] } });
lines.push({ type: "event_msg", payload: { type: "task_complete" } });
await appendFile(process.env.TRANSCRIPT, lines.map((line) => JSON.stringify(line)).join("\\n") + "\\n");
`);
  await chmod(codex, 0o755);
  return { root, transcript, codex };
}

async function invoke(mode) {
  const value = await fixture(mode);
  try {
    const result = await exec(process.execPath, [nativeCall,
      "--agent", "codex", "--session", sessionId,
      "--correlation-id", "task-native-test", "--timeout", "1", "--message", "Return result"
    ], { env: { ...process.env, CODEX_BIN: value.codex, CODEX_SESSION_ROOT: join(value.root, "sessions"), TRANSCRIPT: value.transcript, AGENT_NATIVE_CALL_POLL_MS: "10" } });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("native Codex queue ignores an earlier completion and returns correlated multiline output", async () => {
  const result = await invoke("success");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "MULTI\nLINE\n");
});

test("native Codex queue accepts the final answer when the anchored turn omits optional markers", async () => {
  const result = await invoke("fallback");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "MESH_CORRELATION_OK\n");
});

test("native Codex queue distinguishes empty, uncorrelated, and parsing failures", async () => {
  const empty = await invoke("empty");
  assert.equal(empty.code, 65, empty.stderr);
  const uncorrelated = await invoke("uncorrelated");
  assert.equal(uncorrelated.code, 66, uncorrelated.stderr);
  const parsing = await invoke("parsing");
  assert.equal(parsing.code, 67, parsing.stderr);
});
