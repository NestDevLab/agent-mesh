import assert from "node:assert/strict";
import test from "node:test";
import "./ts-extension-resolver.mjs";

const { LimenCliBroker } = await import("../src/adapters/limen-cli-broker.js");

const request = { runId: "run-1", provider: "codex", harness: "codex", workClass: "L3", project: "limen", session: "session-1", eligibleWork: 2 };

test("maps a deferred Limen exit 75 to the typed broker protocol without a shell", async () => {
  const runner = { calls: [], async run(executable, args) { this.calls.push({ executable, args }); return { code: 75, stdout: JSON.stringify({ decision: "defer", retryAt: 123, decisionId: "d", configHash: "c", workClass: "L3", concurrencyTarget: 0, reasons: ["over_pace"] }), stderr: "" }; } };
  const broker = new LimenCliBroker({ runner, configPath: "/etc/limen/policy.json", executable: "/usr/bin/limen" });
  const result = await broker.admit(request);
  assert.equal(result.decision, "defer");
  assert.equal(runner.calls[0].executable, "/usr/bin/limen");
  assert.deepEqual(runner.calls[0].args.slice(0, 10), ["admit", "--config", "/etc/limen/policy.json", "--provider", "codex", "--harness", "codex", "--run-id", "run-1", "--class"]);
});

test("rejects exit/payload disagreement and malformed output", async () => {
  const mismatch = new LimenCliBroker({ configPath: "policy", runner: { async run() { return { code: 75, stdout: JSON.stringify({ decision: "admit", retryAt: null, decisionId: "d", configHash: "c", workClass: "L3", concurrencyTarget: 1, reasons: [] }), stderr: "" }; } } });
  await assert.rejects(mismatch.admit(request), /protocol mismatch/);
  const malformed = new LimenCliBroker({ configPath: "policy", runner: { async run() { return { code: 0, stdout: "not-json", stderr: "" }; } } });
  await assert.rejects(malformed.admit(request), /invalid JSON/);
});
