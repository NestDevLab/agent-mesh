#!/usr/bin/env node
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const EXIT_DEFER = 75;
const classes = new Set(["L1", "L2", "L3"]);
const priority = { L1: 0, L2: 1, L3: 2 };

export async function main(argv, io = process) {
  const [command, ...rest] = argv;
  if (command !== "submit" && command !== "drain") return usage(io);
  const parsed = parse(rest, command);
  if (!parsed) return usage(io);
  if (command === "submit") return submit(parsed, io);
  return drain(parsed, io);
}

async function submit(options, io) {
  const request = admissionArgs(options);
  const admission = await runLimen(options.limen, request);
  if (admission.decision === "defer") {
    const retryAt = admission.retryAt ?? Date.now() + options.retryMs;
    await updateLedger(options.state, ledger => {
      const existing = ledger.jobs.find(job => job.runId === options.runId && job.status === "waiting_capacity");
      if (existing) Object.assign(existing, { retryAt, admission, updatedAt: Date.now() });
      else ledger.jobs.push({ id: randomUUID(), runId: options.runId, workClass: options.workClass, status: "waiting_capacity", retryAt, attempts: 1, createdAt: Date.now(), updatedAt: Date.now(), options: serializable(options), admission });
    });
    io.stderr.write(`${JSON.stringify({ status: "waiting_capacity", retryAt, decisionId: admission.decisionId, configHash: admission.configHash, workClass: options.workClass, reasons: admission.reasons })}\n`);
    return EXIT_DEFER;
  }
  return deliver(options, io);
}

async function drain(options, io) {
  const due = await claimDue(options.state, options.now, options.limit);
  const outcomes = [];
  for (const job of due) {
    const restored = { ...job.options, state: options.state };
    try {
      const admission = await runLimen(restored.limen, admissionArgs(restored));
      if (admission.decision === "defer") {
        const retryAt = admission.retryAt ?? Date.now() + restored.retryMs;
        await transition(options.state, job.id, { status: "waiting_capacity", retryAt, admission, updatedAt: Date.now() });
        outcomes.push({ runId: job.runId, status: "waiting_capacity", retryAt });
        continue;
      }
      const code = await deliver(restored, io);
      await transition(options.state, job.id, { status: code === 0 || code === 4 || code === 124 ? "dispatched" : "failed", exitCode: code, updatedAt: Date.now() });
      outcomes.push({ runId: job.runId, status: code === 0 || code === 4 || code === 124 ? "dispatched" : "failed", exitCode: code });
    } catch (error) {
      const retryAt = Date.now() + restored.retryMs;
      await transition(options.state, job.id, { status: "waiting_capacity", retryAt, reason: bounded(error), updatedAt: Date.now() });
      outcomes.push({ runId: job.runId, status: "waiting_capacity", retryAt, reason: bounded(error) });
    }
  }
  io.stdout.write(`${JSON.stringify({ schemaVersion: 1, outcomes })}\n`);
  return outcomes.some(item => item.status === "waiting_capacity") ? EXIT_DEFER : outcomes.some(item => item.status === "failed") ? 1 : 0;
}

async function deliver(options, io) {
  const result = await execute(options.command[0], options.command.slice(1), { stdout: "inherit", stderr: "inherit" });
  if (result.code === 0) {
    const complete = ["complete", "--config", options.policy, "--provider", options.provider, "--harness", options.harness, "--run-id", options.runId];
    const reconciled = await execute(options.limen, complete, { stdout: "pipe", stderr: "pipe" });
    if (reconciled.code !== 0) io.stderr.write(`Limen completion pending: exit=${reconciled.code} ${reconciled.stderr.slice(0, 160)}\n`);
  }
  return result.code;
}

function admissionArgs(options) {
  const args = ["admit", "--config", options.policy, "--provider", options.provider, "--harness", options.harness, "--run-id", options.runId, "--class", options.workClass];
  for (const [flag, value] of [["--project", options.project], ["--session", options.session], ["--model", options.model], ["--effort", options.effort]]) if (value) args.push(flag, value);
  return args;
}

async function runLimen(executable, args) {
  const result = await execute(executable, args, { stdout: "pipe", stderr: "pipe" });
  if (result.code !== 0 && result.code !== EXIT_DEFER) throw new Error(`limen exit ${result.code}: ${result.stderr.slice(0, 160)}`);
  let output;
  try { output = JSON.parse(result.stdout.trim()); } catch { throw new Error("limen returned invalid JSON"); }
  if ((output.decision !== "admit" && output.decision !== "defer") || (result.code === 0) !== (output.decision === "admit")) throw new Error("limen exit/payload mismatch");
  return output;
}

function parse(args, command) {
  const values = { limen: "limen", retryMs: 60_000, limit: 32, now: Date.now() };
  const tail = args.indexOf("--");
  const flags = tail >= 0 ? args.slice(0, tail) : args;
  values.command = tail >= 0 ? args.slice(tail + 1) : [];
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index], value = flags[index + 1];
    if (!flag?.startsWith("--") || value === undefined) return null;
    const key = { "--state": "state", "--limen": "limen", "--policy": "policy", "--provider": "provider", "--harness": "harness", "--run-id": "runId", "--class": "workClass", "--project": "project", "--session": "session", "--model": "model", "--effort": "effort", "--retry-ms": "retryMs", "--limit": "limit", "--now": "now" }[flag];
    if (!key) return null;
    values[key] = ["retryMs", "limit", "now"].includes(key) ? Number(value) : value;
  }
  if (!values.state || !Number.isSafeInteger(values.limit) || values.limit < 1 || !Number.isSafeInteger(values.now) || values.now < 0) return null;
  if (command === "drain") return values;
  return values.policy && values.runId && (values.provider === "codex" || values.provider === "claude") && (values.harness === "codex" || values.harness === "claude") && classes.has(values.workClass) && values.command.length ? values : null;
}

const serializable = options => Object.fromEntries(Object.entries(options).filter(([key]) => key !== "now" && key !== "limit"));
const empty = () => ({ schemaVersion: 1, jobs: [] });

async function updateLedger(path, update) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  try { await mkdir(lock, { mode: 0o700 }); } catch { throw new Error("capacity queue lock busy"); }
  try {
    let ledger = empty();
    try { ledger = JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.jobs)) throw new Error("invalid capacity queue");
    await update(ledger);
    const temporary = join(dirname(path), `.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
    await rename(temporary, path); await chmod(path, 0o600);
  } finally { await rm(lock, { recursive: true, force: true }); }
}

async function claimDue(path, now, limit) {
  const claimed = [];
  await updateLedger(path, ledger => {
    for (const job of ledger.jobs) if (job.status === "running" && now - (job.claimedAt ?? 0) > 600_000) job.status = "waiting_capacity";
    const due = ledger.jobs.filter(job => job.status === "waiting_capacity" && job.retryAt <= now).sort((a, b) => priority[a.workClass] - priority[b.workClass] || a.retryAt - b.retryAt || a.id.localeCompare(b.id)).slice(0, limit);
    for (const job of due) { job.status = "running"; job.claimedAt = now; job.attempts += 1; claimed.push(structuredClone(job)); }
  });
  return claimed;
}

const transition = (path, id, patch) => updateLedger(path, ledger => { const job = ledger.jobs.find(item => item.id === id); if (!job) throw new Error("capacity job missing"); Object.assign(job, patch); });
const bounded = error => (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ").slice(0, 240);

function execute(executable, args, streams) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", streams.stdout, streams.stderr], shell: false });
    let stdout = "", stderr = "";
    child.stdout?.on("data", chunk => { stdout += chunk; }); child.stderr?.on("data", chunk => { stderr += chunk; });
    child.on("error", reject); child.on("close", code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function usage(io) { io.stderr.write("usage: mesh-capacity-dispatch.mjs submit --state FILE --policy FILE --provider codex|claude --harness codex|claude --run-id ID --class L1|L2|L3 -- COMMAND... | drain --state FILE [--now MS] [--limit N]\n"); return 2; }
if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(bounded(error)); process.exitCode = 2; });
