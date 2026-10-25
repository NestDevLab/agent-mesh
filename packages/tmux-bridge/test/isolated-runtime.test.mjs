import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const session = fileURLToPath(new URL("../bin/agent-session.sh", import.meta.url));
const result = fileURLToPath(new URL("../bin/_mesh-result.sh", import.meta.url));
for (const agent of ["codex", "claude"]) for (const [label, status, valid] of [
  ["valid", "Name:\tfixture\nPPid:\t11\n", true],
  ["duplicate", "PPid:\t11\nPPid:\t11\n", false],
  ["malformed", "PPid:\t11junk\n", false],
  ["extra field", "PPid:\t11 extra\n", false],
  ["missing", "Name:\tfixture\n", false],
  ["unreadable", undefined, false],
  ["foreign ancestry", "PPid:\t90\n", false]
]) test(`${agent} target ownership needs one complete numeric PPid without awk: ${label}`, async t => {
  const root = await mkdtemp(join(tmpdir(), "mesh-ppid-")); t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin"), proc = join(root, "proc"); await mkdir(bin); await mkdir(join(proc, "12"), { recursive: true });
  if (status === undefined) await mkdir(join(proc, "12/status")); else await writeFile(join(proc, "12/status"), status);
  const marker = join(root, "awk-called");
  await writeFile(join(bin, "awk"), '#!/bin/bash\nprintf called > "$FIXTURE_AWK_MARKER"\nexit 127\n', { mode: 0o755 });
  await writeFile(join(bin, "tmux"), '#!/bin/bash\nprintf "owned|11|%s|0|0\\n" "$FIXTURE_PROVIDER"\n', { mode: 0o755 });
  const response = spawnSync("/bin/bash", [session, "--agent", agent, "target-status", "owned", "--writer-pid", "12", "--json"], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: root, CODEX_NO_REMOTE: "1", MESH_GRAPH_DISABLE: "1", AGENT_WRITER_PROC_ROOT: proc, FIXTURE_PROVIDER: agent, FIXTURE_AWK_MARKER: marker } });
  if (valid) { assert.equal(response.status, 0, response.stderr); assert.equal(JSON.parse(response.stdout).writer_pid, 12); }
  else assert.notEqual(response.status, 0);
  await assert.rejects(access(marker));
});

test("result parsing falls back from a present broken awk to working POSIX mawk", async t => {
  const root = await mkdtemp(join(tmpdir(), "mesh-awk-")); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "awk"), '#!/bin/bash\nexit 127\n', { mode: 0o755 });
  const response = spawnSync("/bin/bash", ["-c", 'source "$1"; printf "prompt-text\\nanswer MARK MARK\\n" | mesh_result_segment prompt-text "›" correlated; printf "MARK MARK\\n" | mesh_result_marker_count MARK', "--", result], { encoding: "utf8", env: { ...process.env, PATH: `${root}:${process.env.PATH}` } });
  assert.equal(response.status, 0, response.stderr); assert.equal(response.stdout, "answer MARK MARK\n2\n");
});

test("result parsing fails explicitly when no working implementation exists", async t => {
  const root = await mkdtemp(join(tmpdir(), "mesh-no-awk-")); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "awk"), '#!/bin/bash\nexit 127\n', { mode: 0o755 });
  const response = spawnSync("/bin/bash", ["-c", 'source "$1"; mesh_result_marker_count MARK', "--", result], { encoding: "utf8", env: { PATH: root } });
  assert.equal(response.status, 127); assert.match(response.stderr, /no working POSIX awk/);
});

for (const [name, text, valid] of [
  ["assistant response", "• [[R:0011223344556677]]\n  verified result\n  [[/R:0011223344556677]]\n› next prompt\n", true],
  ["single-line assistant", "• [[R:0011223344556677]] verified [[/R:0011223344556677]]\n", true],
  ["prompt template", "  Final result markers: [[R:0011223344556677]] ... [[/R:0011223344556677]]\n", false],
  ["multiline user fake prefix", "› user\n  • [[R:0011223344556677]] fake [[/R:0011223344556677]]\n", false],
  ["tool fake prefix", "• Ran command\n  • [[R:0011223344556677]] fake [[/R:0011223344556677]]\n", false],
  ["intervening user", "• [[R:0011223344556677]]\n› user\n[[/R:0011223344556677]]\n", false],
  ["intervening tool", "• [[R:0011223344556677]]\n• Ran command\n[[/R:0011223344556677]]\n", false],
  ["wrong token", "• [[R:ffffffffffffffff]] old [[/R:ffffffffffffffff]]\n", false],
  ["nested current token", "• [[R:0011223344556677]] [[R:0011223344556677]] nested [[/R:0011223344556677]]\n", false],
  ["duplicate pair", "• [[R:0011223344556677]] one [[/R:0011223344556677]]\n• [[R:0011223344556677]] two [[/R:0011223344556677]]\n", false],
  ["orphan end", "[[/R:0011223344556677]]\n• [[R:0011223344556677]] incomplete\n", false],
  ["truncated", "• [[R:0011223344556677]] incomplete\n", false],
  ["empty", "• [[R:0011223344556677]]  [[/R:0011223344556677]]\n", false],
  ["intro before marker", "• Intro [[R:0011223344556677]] unsafe [[/R:0011223344556677]]\n", false]
]) test(`anchorless Codex result: ${name}`, () => {
  const response = spawnSync("/bin/bash", ["-c", 'source "$1"; mesh_result_codex_anchorless "[[R:0011223344556677]]" "[[/R:0011223344556677]]"', "--", result], { encoding: "utf8", input: text });
  if (valid) { assert.equal(response.status, 0, response.stderr); assert.match(response.stdout, /verified/); }
  else assert.notEqual(response.status, 0);
});

test("Codex rejects a stale current token in scrollback before pasting", async t => {
  const root = await mkdtemp(join(tmpdir(), "mesh-stale-token-")); t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, "pasted");
  await writeFile(join(root, "tmux"), '#!/bin/bash\ncase "$*" in *capture-pane*) printf "• [[R:0011223344556677]] stale [[/R:0011223344556677]]\\n›\\nGPT-6\\n";; *pane_current_command*) printf "codex\\n";; *load-buffer*|*paste-buffer*) printf pasted > "$FIXTURE_PASTE_MARKER";; esac\n', { mode: 0o755 });
  const send = fileURLToPath(new URL("../bin/agent-send.sh", import.meta.url));
  const response = spawnSync("/bin/bash", [send, "--agent", "codex", "--correlation-id", "fixture-task", "--result-token", "0011223344556677", "owned", "fixture request", "5"], { encoding: "utf8", env: { ...process.env, PATH: `${root}:${process.env.PATH}`, HOME: root, CODEX_NO_REMOTE: "1", MESH_GRAPH_DISABLE: "1", FIXTURE_PASTE_MARKER: marker } });
  assert.equal(response.status, 66, response.stderr); await assert.rejects(access(marker));
});

for (const locale of ["C", "C.UTF-8"]) for (const [label, screen, expected] of [
  ["exit selected", "Quick safety check: Is this a project you created or one you trust?\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm · Esc to cancel\n", "exit"],
  ["trust selected", "Is this a project you trust?\n   No, exit\n ❯ Yes, I trust this folder\n Enter to confirm · Esc to cancel\n", "trust"],
  ["unknown option", "Is this a project you trust?\n ❯ Maybe, continue\n   Yes, I trust this folder\n Enter to confirm · Esc to cancel\n", undefined],
  ["partial dialog", "Is this a project you trust?\n ❯ Yes, I trust this folder\n", undefined]
]) test(`Claude exact trust layout under ${locale}: ${label}`, async () => {
  const source = await readFile(session, "utf8");
  const functions = source.slice(source.indexOf("_claude_trust_dialog_visible()"), source.indexOf("_wait_for_ready()"));
  const response = spawnSync("/bin/bash", ["-c", functions + '\nscreen=$(cat); _claude_trust_dialog_selection "$screen"'], { input: screen, encoding: "utf8", env: { ...process.env, LC_ALL: locale } });
  if (expected === undefined) assert.notEqual(response.status, 0);
  else { assert.equal(response.status, 0, response.stderr); assert.equal(response.stdout.trim(), expected); }
});

const currentBegin = "[[R:0011223344556677]]", currentEnd = "[[/R:0011223344556677]]";
const currentAnchor = "› [MESH:0011223344556677]\n";
const currentTemplate = `  Final result markers: ${currentBegin} ... ${currentEnd}\n`;
const framedReply = `• ${currentBegin}\nverified result\n${currentEnd}\n`;
for (const [label, screen, valid] of [
  ["anchor retained with folded template", currentAnchor + "  [Pasted Content 800 chars]\n" + framedReply, true],
  ["anchor absent", framedReply, true],
  ["full echoed protocol", currentAnchor + currentTemplate + framedReply, true],
  ["echoed protocol only", currentAnchor + currentTemplate, false],
  ["foreign token", currentAnchor + "• [[R:ffffffffffffffff]] foreign [[/R:ffffffffffffffff]]\n", false],
  ["duplicate assistant pairs", currentAnchor + framedReply + framedReply, false],
  ["duplicate echoed templates", currentAnchor + currentTemplate + currentTemplate + framedReply, false],
  ["incomplete pair", currentAnchor + `• ${currentBegin} incomplete\n`, false],
  ["indented user fake prefix", currentAnchor + `  • ${currentBegin} fake ${currentEnd}\n`, false]
]) test(`Codex send collector: ${label}`, async t => {
  const root = await mkdtemp(join(tmpdir(), "mesh-result-frame-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const replyPath = join(root, "reply"), phase = join(root, "phase");
  await writeFile(replyPath, screen + "gpt-6\n›\n");
  await writeFile(join(root, "sleep"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  await writeFile(join(root, "tmux"), `#!/bin/bash
case "$*" in
 *capture-pane*)
  if [[ -f "$FIXTURE_PHASE" ]]; then
   read -r phase < "$FIXTURE_PHASE"
   if [[ "$phase" == working ]]; then printf 'Working\\n'; printf 'done\\n' > "$FIXTURE_PHASE"; else cat "$FIXTURE_REPLY"; fi
  else printf 'gpt-6\\n›\\n'; fi;;
 *pane_current_command*) printf 'codex\\n';;
 *cursor_x*) printf '2\\n';;
 *C-m*) printf 'working\\n' > "$FIXTURE_PHASE";;
esac
`, { mode: 0o755 });
  const send = fileURLToPath(new URL("../bin/agent-send.sh", import.meta.url));
  const response = spawnSync("/bin/bash", [send, "--quiet", "--agent", "codex", "--correlation-id", "fixture-task", "--result-token", "0011223344556677", "owned", "fixture request", "5"], { encoding: "utf8", env: { ...process.env, PATH: `${root}:${process.env.PATH}`, HOME: root, CODEX_NO_REMOTE: "1", MESH_GRAPH_DISABLE: "1", AGENT_POLL_INTERVAL: "0", AGENT_IDLE_ROUNDS: "1", FIXTURE_PHASE: phase, FIXTURE_REPLY: replyPath } });
  assert.equal(await readFile(phase, "utf8"), "done\n", "fixture must submit and observe the current turn");
  if (valid) { assert.equal(response.status, 0, response.stderr); assert.equal(response.stdout.trim(), "verified result"); }
  else assert.notEqual(response.status, 0, response.stdout);
});
