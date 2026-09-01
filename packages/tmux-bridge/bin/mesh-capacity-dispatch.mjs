#!/usr/bin/env node
import { appendFile, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const EXIT_DEFER = 75;
const classes = new Set(["L1", "L2", "L3"]);
const priority = { L1: 0, L2: 1, L3: 2 };

export async function main(argv, io = process) {
  const [command, ...rest] = argv;
  if (command !== "submit" && command !== "drain" && command !== "monitor") return usage(io);
  const parsed = parse(rest, command);
  if (!parsed) return usage(io);
  if (command === "submit") return submit(parsed, io);
  if (command === "monitor") return monitor(parsed, io);
  return drain(parsed, io);
}

async function submit(options, io) {
  const request = admissionArgs(options);
  const admission = await runLimen(options.limen, request);
  verifyRouteTarget(options, admission);
  if (admission.decision === "defer") {
    const retryAt = admission.retryAt ?? Date.now() + options.retryMs;
    await updateLedger(options.state, ledger => {
      const existing = ledger.jobs.find(job => job.runId === options.runId && job.status === "waiting_capacity");
      if (existing) Object.assign(existing, { retryAt, admission, updatedAt: Date.now() });
      else ledger.jobs.push({ id: randomUUID(), runId: options.runId, workClass: options.workClass, status: "waiting_capacity", retryAt, attempts: 1, createdAt: Date.now(), updatedAt: Date.now(), options: serializable(options), admission });
    });
    await recordEvent(options, "waiting_capacity", { retryAt, admission, eligibleWork: options.eligibleWork });
    io.stderr.write(`${JSON.stringify({ status: "waiting_capacity", retryAt, decisionId: admission.decisionId, configHash: admission.configHash, workClass: options.workClass, reasons: admission.reasons })}\n`);
    return EXIT_DEFER;
  }
  return deliver(options, io, admission);
}

async function drain(options, io) {
  const due = await claimDue(options.state, options.now, options.limit);
  const outcomes = [];
  for (const job of due) {
    const restored = { ...job.options, state: options.state, events: options.events, now: options.now, eligibleWork: due.length, attempts: job.attempts };
    let dispatchStarted = false;
    try {
      await recordEvent(restored, "claimed", { attempts: job.attempts, eligibleWork: due.length });
      const admission = await runLimen(restored.limen, admissionArgs(restored));
      verifyRouteTarget(restored, admission);
      if (admission.decision === "defer") {
        const retryAt = admission.retryAt ?? Date.now() + restored.retryMs;
        await transition(options.state, job.id, { status: "waiting_capacity", retryAt, admission, updatedAt: Date.now() });
        await recordEvent(restored, "waiting_capacity", { retryAt, admission, attempts: job.attempts, eligibleWork: due.length });
        outcomes.push({ runId: job.runId, status: "waiting_capacity", retryAt });
        continue;
      }
      await transition(options.state, job.id, { status: "dispatching", admission, updatedAt: Date.now() });
      await recordEvent(restored, "dispatching", { admission, attempts: job.attempts, eligibleWork: due.length });
      dispatchStarted = true;
      const code = await deliver(restored, io, admission);
      await transition(options.state, job.id, { status: code === 0 || code === 4 || code === 124 ? "dispatched" : "failed", exitCode: code, updatedAt: Date.now() });
      outcomes.push({ runId: job.runId, status: code === 0 || code === 4 || code === 124 ? "dispatched" : "failed", exitCode: code });
    } catch (error) {
      if (dispatchStarted) {
        try { await transition(options.state, job.id, { status: "dispatch_unknown", reason: bounded(error), updatedAt: Date.now() }); } catch {}
        await recordEventAfterDispatch(restored, "dispatch_unknown", { reason: bounded(error), attempts: job.attempts, eligibleWork: due.length }, io);
        outcomes.push({ runId: job.runId, status: "dispatch_unknown", reason: bounded(error) });
        continue;
      }
      const retryAt = Date.now() + restored.retryMs;
      await transition(options.state, job.id, { status: "waiting_capacity", retryAt, reason: bounded(error), updatedAt: Date.now() });
      await recordEvent(restored, "waiting_capacity", { retryAt, reason: bounded(error), attempts: job.attempts, eligibleWork: due.length });
      outcomes.push({ runId: job.runId, status: "waiting_capacity", retryAt, reason: bounded(error) });
    }
  }
  io.stdout.write(`${JSON.stringify({ schemaVersion: 1, outcomes })}\n`);
  return outcomes.some(item => item.status === "waiting_capacity") ? EXIT_DEFER : outcomes.some(item => item.status === "failed" || item.status === "dispatch_unknown") ? 1 : 0;
}

async function deliver(options, io, admission) {
  await recordEvent(options, "admitted", { admission, eligibleWork: options.eligibleWork });
  const result = await execute(options.command[0], options.command.slice(1), {
    stdout: "inherit",
    stderr: "inherit",
    env: admission.lease?.candidate ? { MESH_LIMEN_ROUTE: JSON.stringify({ provider: admission.provider, model: admission.model, nativeModel: admission.nativeModel, effort: admission.effort, decisionId: admission.decisionId, candidate: admission.lease.candidate }) } : undefined,
  });
  const dispatched = result.code === 0 || result.code === 4 || result.code === 124;
  await recordEventAfterDispatch(options, dispatched ? "dispatched" : "failed", { admission, reason: dispatched ? "command_dispatched" : `command_exit_${result.code}`, eligibleWork: options.eligibleWork }, io);
  if (dispatched && options.lifecycle === "session") {
    await upsertSession(options.state, options, admission, "active");
    await recordEventAfterDispatch(options, "session_active", { admission, reason: "session_lease_open", eligibleWork: options.eligibleWork }, io);
    startMonitor(options);
    return result.code;
  }
  if (result.code === 0) {
    const complete = ["complete", "--config", options.policy, "--provider", options.provider, "--harness", options.harness, "--run-id", options.runId];
    if (options.session) complete.push("--session", options.session);
    const reconciled = await execute(options.limen, complete, { stdout: "pipe", stderr: "pipe" });
    if (reconciled.code !== 0) {
      await recordEventAfterDispatch(options, "completion_pending", { admission, reason: `limen_complete_exit_${reconciled.code}`, eligibleWork: options.eligibleWork }, io);
      io.stderr.write(`Limen completion pending: exit=${reconciled.code} ${reconciled.stderr.slice(0, 160)}\n`);
    }
  }
  return result.code;
}

function admissionArgs(options) {
  if (options.profile) {
    const args = ["route", "--config", options.policy, "--profile", options.profile, "--harness", options.harness, "--run-id", options.runId, "--class", options.workClass];
    for (const [flag, value] of [["--project", options.project], ["--session", options.session]]) if (value) args.push(flag, value);
    if (Number.isSafeInteger(options.eligibleWork)) args.push("--eligible-work", String(options.eligibleWork));
    return args;
  }
  const args = ["admit", "--config", options.policy, "--provider", options.provider, "--harness", options.harness, "--run-id", options.runId, "--class", options.workClass];
  for (const [flag, value] of [["--project", options.project], ["--session", options.session], ["--model", options.model], ["--effort", options.effort]]) if (value) args.push(flag, value);
  if (Number.isSafeInteger(options.eligibleWork)) args.push("--eligible-work", String(options.eligibleWork));
  return args;
}

function verifyRouteTarget(options, admission) {
  if (options.profile && admission.decision === "route" && admission.provider !== options.provider) {
    throw new Error(`routed provider ${admission.provider} does not match target ${options.provider}`);
  }
}

async function runLimen(executable, args) {
  const result = await execute(executable, args, { stdout: "pipe", stderr: "pipe" });
  if (result.code !== 0 && result.code !== EXIT_DEFER) throw new Error(`limen exit ${result.code}: ${result.stderr.slice(0, 160)}`);
  let output;
  try { output = JSON.parse(result.stdout.trim()); } catch { throw new Error("limen returned invalid JSON"); }
  const routed = Boolean(output.decision === "route" && output.lease && output.provider && output.model && /^[A-Za-z0-9_.:-]{1,96}$/.test(output.nativeModel || "") && output.effort);
  const admitted = output.decision === "admit";
  if ((!admitted && !routed && output.decision !== "defer") || (result.code === 0) !== (admitted || routed)) throw new Error("limen exit/payload mismatch");
  return output;
}

function parse(args, command) {
  const values = { limen: "limen", retryMs: 60_000, renewMs: 60_000, limit: 32, now: Date.now(), eligibleWork: 1 };
  const tail = args.indexOf("--");
  const flags = tail >= 0 ? args.slice(0, tail) : args;
  values.command = tail >= 0 ? args.slice(tail + 1) : [];
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index], value = flags[index + 1];
    if (!flag?.startsWith("--") || value === undefined) return null;
    const key = { "--state": "state", "--events": "events", "--limen": "limen", "--policy": "policy", "--provider": "provider", "--harness": "harness", "--run-id": "runId", "--class": "workClass", "--project": "project", "--session": "session", "--target": "target", "--alive-pattern": "alivePattern", "--profile": "profile", "--lifecycle": "lifecycle", "--model": "model", "--effort": "effort", "--eligible-work": "eligibleWork", "--retry-ms": "retryMs", "--renew-ms": "renewMs", "--limit": "limit", "--now": "now" }[flag];
    if (!key) return null;
    values[key] = ["retryMs", "renewMs", "limit", "now", "eligibleWork"].includes(key) ? Number(value) : value;
  }
  if (!values.state || !Number.isSafeInteger(values.limit) || values.limit < 1 || !Number.isSafeInteger(values.now) || values.now < 0 || !Number.isSafeInteger(values.eligibleWork) || values.eligibleWork < 0 || !Number.isSafeInteger(values.renewMs) || values.renewMs < 1) return null;
  values.events ||= `${values.state}.events.ndjson`;
  if (command === "drain") return values;
  const validLimen = values.policy && values.runId && (values.provider === "codex" || values.provider === "claude") && (values.harness === "codex" || values.harness === "claude") && classes.has(values.workClass);
  if (command === "monitor") return validLimen && values.session && values.target ? values : null;
  if (!validLimen || !values.command.length || (values.lifecycle && values.lifecycle !== "session")) return null;
  if (values.lifecycle === "session" && (!values.profile || !values.target || values.model || values.effort)) return null;
  return values;
}

const serializable = options => Object.fromEntries(Object.entries(options).filter(([key]) => key !== "now" && key !== "limit"));
const empty = () => ({ schemaVersion: 1, jobs: [], sessions: [] });

async function updateLedger(path, update) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  try { await mkdir(lock, { mode: 0o700 }); } catch { throw new Error("capacity queue lock busy"); }
  try {
    let ledger = empty();
    try { ledger = JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.jobs) || ledger.sessions !== undefined && !Array.isArray(ledger.sessions)) throw new Error("invalid capacity queue");
    ledger.sessions ||= [];
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
const transitionSession = (path, runId, patch) => updateLedger(path, ledger => { const session = ledger.sessions.find(item => item.runId === runId); if (!session) throw new Error("capacity session missing"); Object.assign(session, patch); });
const bounded = error => (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ").slice(0, 240);

async function upsertSession(path, options, admission, status) {
  await updateLedger(path, ledger => {
    const record = {
      runId: options.runId,
      target: options.target || options.session,
      provider: admission.provider,
      harness: options.harness,
      workClass: options.workClass,
      profile: options.profile,
      policy: options.policy,
      candidate: admission.lease?.candidate,
      decisionId: admission.decisionId,
      configHash: admission.configHash,
      status,
      updatedAt: Date.now(),
    };
    const existing = ledger.sessions.find(item => item.runId === options.runId);
    if (existing) Object.assign(existing, record);
    else ledger.sessions.push({ ...record, createdAt: Date.now() });
  });
}

const runHash = options => createHash("sha256").update([options.provider, options.harness, options.session, options.runId].filter(Boolean).join("|")).digest("hex");
async function recordEvent(options, status, details = {}) {
  const admission = details.admission;
  const candidate = admission?.lease?.candidate || admission?.candidate;
  const event = {
    schemaVersion: 1,
    event: "limen.queue",
    eventId: randomUUID(),
    at: Number.isSafeInteger(options.now) ? options.now : Date.now(),
    runHash: runHash(options),
    provider: options.provider,
    harness: options.harness,
    workClass: options.workClass,
    status,
    attempts: Number.isSafeInteger(details.attempts) ? details.attempts : Number.isSafeInteger(options.attempts) ? options.attempts : 1,
    eligibleWork: Number.isSafeInteger(details.eligibleWork) ? details.eligibleWork : 0,
    ...(Number.isSafeInteger(details.retryAt) ? { retryAt: details.retryAt } : {}),
    ...(admission?.decisionId ? { decisionId: admission.decisionId } : {}),
    ...(admission?.configHash ? { configHash: admission.configHash } : {}),
    ...(candidate ? { candidate } : {}),
    ...(details.reason ? { reason: bounded(details.reason) } : {}),
  };
  await mkdir(dirname(options.events), { recursive: true, mode: 0o700 });
  await appendFile(options.events, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  await chmod(options.events, 0o600);
}

async function recordEventAfterDispatch(options, status, details, io) {
  try { await recordEvent(options, status, details); }
  catch (error) { io.stderr.write(`Limen queue evidence unavailable after dispatch: ${bounded(error)}\n`); }
}

function execute(executable, args, streams) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", streams.stdout, streams.stderr], shell: false, ...(streams.env ? { env: { ...process.env, ...streams.env } } : {}) });
    let stdout = "", stderr = "";
    child.stdout?.on("data", chunk => { stdout += chunk; }); child.stderr?.on("data", chunk => { stderr += chunk; });
    child.on("error", reject); child.on("close", code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function startMonitor(options) {
  const args = [process.argv[1], "monitor", "--state", options.state, "--events", options.events, "--limen", options.limen, "--policy", options.policy, "--provider", options.provider, "--harness", options.harness, "--run-id", options.runId, "--class", options.workClass, "--session", options.session, "--target", options.target || options.session, "--renew-ms", String(options.renewMs)];
  if (options.profile) args.push("--profile", options.profile);
  if (options.alivePattern) args.push("--alive-pattern", options.alivePattern);
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", env: process.env });
  child.unref();
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const completionArgs = options => {
  const args = ["complete", "--config", options.policy, "--provider", options.provider, "--harness", options.harness, "--run-id", options.runId];
  if (options.session) args.push("--session", options.session);
  return args;
};

const parseJson = text => { try { return JSON.parse(text.trim()); } catch { return null; } };

async function liveTarget(options) {
  const exists = await execute("tmux", ["-L", process.env.MESH_TMUX_SOCKET || "mesh", "has-session", "-t", options.target], { stdout: "ignore", stderr: "ignore" });
  if (exists.code !== 0) return false;
  const pane = await execute("tmux", ["-L", process.env.MESH_TMUX_SOCKET || "mesh", "display-message", "-p", "-t", options.target, "#{pane_pid}"], { stdout: "pipe", stderr: "ignore" });
  const panePid = Number(pane.stdout.trim());
  if (pane.code !== 0 || !Number.isSafeInteger(panePid) || panePid < 1) return false;
  const processes = await execute("ps", ["-eo", "pid=,ppid=,comm="], { stdout: "pipe", stderr: "ignore" });
  if (processes.code !== 0) return false;
  const children = new Map();
  for (const line of processes.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]), parent = Number(match[2]), command = match[3].trim();
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push({ pid, command });
  }
  const pattern = options.alivePattern || `^${options.provider}$`;
  try {
    const expression = new RegExp(pattern);
    const pending = [panePid];
    while (pending.length) {
      const parent = pending.pop();
      for (const child of children.get(parent) || []) {
        if (expression.test(child.command)) return true;
        pending.push(child.pid);
      }
    }
    return false;
  }
  catch { return false; }
}

async function monitor(options, io) {
  while (true) {
    if (await liveTarget(options)) {
      const renewal = await execute(options.limen, ["renew", "--config", options.policy, "--provider", options.provider, "--harness", options.harness, "--run-id", options.runId, "--session", options.session], { stdout: "pipe", stderr: "pipe" });
      const output = parseJson(renewal.stdout);
      if (renewal.code === 0 && output?.status === "renewed") {
        await transitionSession(options.state, options.runId, { status: "active", expiresAt: output.expiresAt, updatedAt: Date.now() });
        await recordEvent(options, "lease_renewed", { admission: output, reason: "lease_renewed" });
      } else if (output?.status === "expired") {
        await transitionSession(options.state, options.runId, { status: "expired", updatedAt: Date.now() });
        await recordEvent(options, "lease_expired", { admission: output, reason: "lease_expired" });
        return 2;
      } else {
        await transitionSession(options.state, options.runId, { status: "renewal_pending", reason: `limen_renew_exit_${renewal.code}`, updatedAt: Date.now() });
        await recordEvent(options, "renewal_pending", { reason: `limen_renew_exit_${renewal.code}` });
      }
    } else {
      const complete = await execute(options.limen, completionArgs(options), { stdout: "pipe", stderr: "pipe" });
      const output = parseJson(complete.stdout);
      if (complete.code === 0 && output?.status === "completed") {
        await transitionSession(options.state, options.runId, { status: "completed", completedAt: Date.now(), updatedAt: Date.now() });
        await recordEvent(options, "completed", { admission: output, reason: "session_gone_completed" });
        return 0;
      }
      if (output?.status === "expired") {
        await transitionSession(options.state, options.runId, { status: "expired", updatedAt: Date.now() });
        await recordEvent(options, "lease_expired", { admission: output, reason: "session_gone_expired" });
        return 2;
      }
      await transitionSession(options.state, options.runId, { status: "completion_pending", reason: `limen_complete_exit_${complete.code}`, updatedAt: Date.now() });
      await recordEvent(options, "completion_pending", { reason: `limen_complete_exit_${complete.code}` });
    }
    await delay(options.renewMs);
  }
}

function usage(io) { io.stderr.write("usage: mesh-capacity-dispatch.mjs submit --state FILE [--events FILE] --policy FILE --provider codex|claude --harness codex|claude --run-id ID --class L1|L2|L3 [--profile NAME] [--eligible-work N] -- COMMAND... | drain --state FILE [--events FILE] [--now MS] [--limit N] | monitor --state FILE [--events FILE] --policy FILE --provider codex|claude --harness codex|claude --run-id ID --class L1|L2|L3 --session ID --target TMUX_TARGET\n"); return 2; }
if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(bounded(error)); process.exitCode = 2; });
