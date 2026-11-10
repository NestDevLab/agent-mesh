/** Resolve a not-yet-persisted native thread only from its exact owned live pane. */
import { readdirSync, readFileSync, readlinkSync, lstatSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const denied = (stage = "proof", code = "DENIED") => Object.assign(
  new Error("Owned Codex thread proof is incomplete or ambiguous."),
  { proofStage: stage, proofCode: typeof code === "string" && /^[A-Z_]{1,32}$/.test(code) ? code : "DENIED" }
);

function processIdentity(procRoot, pid) {
    const raw = readFileSync(`${procRoot}/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\s+/);
    const ppid = Number(fields[1]);
    if (!Number.isSafeInteger(ppid) || !/^\d+$/.test(fields[19] ?? "")) throw denied();
    return { ppid, start: fields[19], state: fields[0] };
}

function readLockAcl(path) {
  return execFileSync("getfacl", ["--omit-header", "--absolute-names", "--", path],
    { encoding: "utf8", timeout: 1000, maxBuffer: 64 * 1024 });
}

export function discoverOwnedCodexThread({ panePid, cwd, procRoot = "/proc", codexHome, readAcl = readLockAcl }) {
  if (!Number.isSafeInteger(panePid) || panePid <= 0 || !isAbsolute(cwd) || resolve(cwd) !== cwd || !isAbsolute(codexHome)) throw denied();
  const processInfo = pid => processIdentity(procRoot, pid);
  const fullyExited = pid => {
    if (processInfo(pid).state !== "Z") return false;
    const status = readFileSync(`${procRoot}/${pid}/status`, "utf8");
    const threads = status.match(/^Threads:[^\n]*$/gm) ?? [];
    // A zombie leader can still have live workers with shared descriptors.
    return threads.length === 1 && /^Threads:\s+1\s*$/.test(threads[0]);
  };
  const gone = pid => {
    // Fully exited single-thread Linux zombies have closed descriptors and cannot hold a
    // writer lock. Their proc entry can outlive exe/cmdline until reaped.
    try { lstatSync(`${procRoot}/${pid}`); return fullyExited(pid); }
    catch (error) { return error.code === "ENOENT"; }
  };
  const inventory = new Map();
  for (const entry of readdirSync(procRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const info = processInfo(entry.name);
      if (!fullyExited(entry.name)) inventory.set(Number(entry.name), info);
    }
    catch (error) { if (!gone(entry.name)) throw denied("inventory.stat", error.code); }
  }
  if (!inventory.has(panePid)) throw denied();
  const ancestors = pid => {
    const chain = [];
    for (let depth = 0; depth < 32; depth++) {
      if (chain.includes(pid)) return undefined;
      const info = inventory.get(pid);
      if (!info) return undefined;
      chain.push(pid);
      if (pid === panePid) return chain;
      pid = info.ppid;
    }
    return undefined;
  };
  const lockRoot = resolve(codexHome, "thread-writer-locks");
  const candidates = new Map();
  const lockHolders = new Map();
  const unobservable = [];
  // Inventory potential writers globally, including processes outside the pane.
  // A filtered/unreadable process must never turn shared ownership into "unique".
  for (const pid of inventory.keys()) {
    let stage = "inventory.exe", chain;
    try {
      let executable;
      try { executable = readlinkSync(`${procRoot}/${pid}/exe`); }
      catch (error) {
        if (error.code !== "EACCES") throw error;
        // Readable argv can exclude a non-Codex process even when exe is protected.
        // Empty or unreadable argv cannot exclude a potential writer.
      }
      // A non-Codex executable can still be a wrapper with Codex argv.
      // Without its cmdline it cannot safely be excluded from writer discovery.
      stage = "inventory.cmdline";
      const argv = readFileSync(`${procRoot}/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      if (executable === undefined && argv.length === 0) throw denied(stage, "EACCES");
      if (basename(executable ?? "") !== "codex" && !argv.some(value => basename(value) === "codex")) continue;
      chain = ancestors(pid);
      stage = "inventory.fds";
      for (const fd of readdirSync(`${procRoot}/${pid}/fd`)) {
        stage = "inventory.fd";
        let path;
        try { path = readlinkSync(`${procRoot}/${pid}/fd/${fd}`); }
        catch (error) {
          // readdir(/proc/self/fd) observes its own directory FD, which is closed
          // before it returns. Only this observer's vanished descriptor is safe
          // to ignore; live/inherited lock FDs and every foreign error stay visible.
          if (pid === process.pid && error.code === "ENOENT") continue;
          throw error;
        }
        const id = basename(path, ".lock");
        if (!UUID.test(id) || path !== `${lockRoot}/${id}.lock`) continue;
        const lock = lstatSync(path);
        const held = statSync(`${procRoot}/${pid}/fd/${fd}`);
        if (!lock.isFile() || lock.dev !== held.dev || lock.ino !== held.ino) throw denied();
        const holder = { pid, id, chain, fd, dev: lock.dev, ino: lock.ino, lock };
        lockHolders.set(`${pid}:${id}`, holder);
        if (chain) {
          if (readlinkSync(`${procRoot}/${pid}/cwd`) !== cwd) throw denied();
          candidates.set(`${pid}:${id}`, holder);
        }
      }
    } catch (error) {
      // A process that exited during inspection no longer holds a lock. Every
      // still-present unobservable potential writer makes the proof incomplete.
      if (gone(pid)) continue;
      if (stage === "inventory.fds" && error.code === "EACCES" && !chain) { unobservable.push(pid); continue; }
      throw error.proofStage ? error : denied(stage, error.code);
    }
  }
  if (candidates.size !== 1) throw denied();
  const candidate = [...candidates.values()][0];
  if ([...lockHolders.values()].filter(holder => holder.id === candidate.id).length !== 1) throw denied();
  // Exclude an unobservable foreign writer only when identity, groups and ACL rule out writing this lock.
  let noExtendedAcl;
  for (const pid of unobservable) {
    try {
      const status = readFileSync(`${procRoot}/${pid}/status`, "utf8");
      const uidLines = status.match(/^Uid:[^\n]*$/gm) ?? [];
      const capLines = status.match(/^CapEff:[^\n]*$/gm) ?? [];
      const uids = uidLines.length === 1 ? /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(uidLines[0])?.slice(1).map(Number) : undefined;
      const caps = capLines.length === 1 ? /^CapEff:\s+([0-9a-fA-F]+)\s*$/.exec(capLines[0]) : undefined;
      if (!uids || uids.some(uid => !Number.isSafeInteger(uid) || uid === 0 || uid === candidate.lock.uid) ||
          !caps || !/^0+$/.test(caps[1]) || (candidate.lock.mode & 0o002) !== 0) throw denied("inventory.fds", "EACCES");
      if ((candidate.lock.mode & 0o020) !== 0) {
        const gidLines = status.match(/^Gid:[^\n]*$/gm) ?? [];
        const groupLines = status.match(/^Groups:[^\n]*$/gm) ?? [];
        const gids = gidLines.length === 1 ? /^Gid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(gidLines[0])?.slice(1).map(Number) : undefined;
        const values = groupLines.length === 1 ? groupLines[0].slice(7).trim().split(/\s+/).filter(Boolean) : undefined;
        const groups = values?.every(value => /^\d+$/.test(value)) ? values.map(Number) : undefined;
        if (!gids || !groups || [...gids, ...groups].some(gid => !Number.isSafeInteger(gid) || gid === candidate.lock.gid)) throw denied("inventory.fds", "EACCES");
        if (noExtendedAcl === undefined) {
          noExtendedAcl = false;
          const acl = readAcl(`${lockRoot}/${candidate.id}.lock`);
          noExtendedAcl = typeof acl === "string" && !acl.split("\n").some(line => /^(?:user:[^:]+:|group:[^:]+:|mask::)/.test(line.trim()));
        }
        if (!noExtendedAcl) throw denied("inventory.fds", "EACCES");
      }
    } catch {
      if (gone(pid)) continue;
      throw denied("inventory.fds", "EACCES");
    }
  }
  // Recheck identity, ancestry, cwd and the held inode after discovery; never trust stale locks.
  for (const pid of candidate.chain) {
    const before = inventory.get(pid);
    const after = processInfo(pid);
    if (before.start !== after.start || before.ppid !== after.ppid) throw denied();
  }
  const fdPath = `${procRoot}/${candidate.pid}/fd/${candidate.fd}`;
  const held = statSync(fdPath);
  if (held.dev !== candidate.dev || held.ino !== candidate.ino || readlinkSync(fdPath) !== `${lockRoot}/${candidate.id}.lock` || readlinkSync(`${procRoot}/${candidate.pid}/cwd`) !== cwd) throw denied();
  return { agent: "codex", sessionId: candidate.id, writers: [{ pid: candidate.pid, kind: "codex" }], panePid, cwd };
}

/** Retry only observations of one pinned pane, never reselect a target or weaken proof. */
export async function waitForOwnedCodexThread(options, {
  timeoutMs = 2_500, intervalMs = 100,
  now = () => performance.now(), wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))
} = {}) {
  const { panePid, procRoot = "/proc" } = options;
  const pinned = processIdentity(procRoot, panePid);
  const deadline = now() + timeoutMs;
  const samePane = () => {
    const current = processIdentity(procRoot, panePid);
    if (current.start !== pinned.start || current.ppid !== pinned.ppid) throw denied("pane.identity", "CHANGED");
  };
  let lastError;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (now() >= deadline) throw lastError ?? denied("proof.retry", "TIMEOUT");
    samePane();
    try {
      const proof = discoverOwnedCodexThread(options);
      samePane();
      if (now() >= deadline) throw denied("proof.retry", "TIMEOUT");
      return proof;
    } catch (error) {
      if (error.proofStage === "pane.identity" || error.proofStage === "proof.retry") throw error;
      lastError = error;
    }
    samePane();
    const remaining = deadline - now();
    if (remaining <= 0) throw lastError;
    await wait(Math.min(intervalMs, remaining));
  }
  throw lastError ?? denied("proof.retry", "TIMEOUT");
}
