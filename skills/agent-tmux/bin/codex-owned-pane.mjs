/** Resolve a not-yet-persisted native thread only from its exact owned live pane. */
import { readdirSync, readFileSync, readlinkSync, lstatSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const denied = () => new Error("Owned Codex thread proof is incomplete or ambiguous.");

export function discoverOwnedCodexThread({ panePid, cwd, procRoot = "/proc", codexHome }) {
  if (!Number.isSafeInteger(panePid) || panePid <= 0 || !isAbsolute(cwd) || resolve(cwd) !== cwd || !isAbsolute(codexHome)) throw denied();
  const processInfo = pid => {
    const raw = readFileSync(`${procRoot}/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\s+/);
    const ppid = Number(fields[1]);
    if (!Number.isSafeInteger(ppid) || !/^\d+$/.test(fields[19] ?? "")) throw denied();
    return { ppid, start: fields[19] };
  };
  const gone = pid => {
    try { lstatSync(`${procRoot}/${pid}`); return false; }
    catch (error) { return error.code === "ENOENT"; }
  };
  const inventory = new Map();
  for (const entry of readdirSync(procRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try { inventory.set(Number(entry.name), processInfo(entry.name)); }
    catch { if (!gone(entry.name)) throw denied(); }
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
  // Inventory potential writers globally, including processes outside the pane.
  // A filtered/unreadable process must never turn shared ownership into "unique".
  for (const pid of inventory.keys()) {
    try {
      let executable;
      try { executable = readlinkSync(`${procRoot}/${pid}/exe`); }
      catch { throw denied(); }
      // A non-Codex executable can still be a wrapper with Codex argv.
      // Without its cmdline it cannot safely be excluded from writer discovery.
      const argv = readFileSync(`${procRoot}/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      if (basename(executable) !== "codex" && !argv.some(value => basename(value) === "codex")) continue;
      const chain = ancestors(pid);
      for (const fd of readdirSync(`${procRoot}/${pid}/fd`)) {
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
        const holder = { pid, id, chain, fd, dev: lock.dev, ino: lock.ino };
        lockHolders.set(`${pid}:${id}`, holder);
        if (chain) {
          if (readlinkSync(`${procRoot}/${pid}/cwd`) !== cwd) throw denied();
          candidates.set(`${pid}:${id}`, holder);
        }
      }
    } catch {
      // A process that exited during inspection no longer holds a lock. Every
      // still-present unobservable potential writer makes the proof incomplete.
      if (gone(pid)) continue;
      throw denied();
    }
  }
  if (candidates.size !== 1) throw denied();
  const candidate = [...candidates.values()][0];
  if ([...lockHolders.values()].filter(holder => holder.id === candidate.id).length !== 1) throw denied();
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
