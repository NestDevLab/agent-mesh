import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

const FORMAT = "agent-mesh.grant-authority/v1";
const MAX_REVISION = (1n << 64n) - 1n;
const UNCOMMITTED_DIGEST = "0".repeat(64);
const BINDING_FIELDS = [
  "kind", "selector", "allowedTools", "allowedAgentIds", "allowedWorkspaceIds", "allowedDomainIds",
  "returnRoutes", "groupGrants", "manageAllGroups", "ledgerReadGrants", "plexusLedgerReadDelegate",
  "allowedGoogleAccounts"
] as const;

type ObjectValue = Record<string, unknown>;
export interface AuthorityState {
  format: typeof FORMAT;
  incarnation: string;
  revision: string;
  digest: string;
  committedAt: string;
}
export type AuthorityResult =
  | { ok: true; incarnation: string; revision: string; digest: string }
  | { ok: false; reason: string };
export interface CommitMetadata { actor: string; reason: string }

class AuthorityError extends Error {
  constructor(readonly code: string) { super(code); }
}
function object(value: unknown): ObjectValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AuthorityError("invalid_config");
  return value as ObjectValue;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().filter(key => (value as ObjectValue)[key] !== undefined)
      .map(key => [key, canonical((value as ObjectValue)[key])]));
  }
  return value;
}
export function authorizationProjection(config: unknown): string {
  const source = object(config);
  if (source.bindings !== undefined && !Array.isArray(source.bindings)) throw new AuthorityError("invalid_config");
  const bindings = ((source.bindings ?? []) as unknown[]).map(value => {
    const binding = object(value);
    return Object.fromEntries(BINDING_FIELDS.filter(key => binding[key] !== undefined).map(key => [key, binding[key]]));
  });
  const owner = source.plexusLedger === undefined ? undefined : object(source.plexusLedger).ownerPrincipalId;
  return JSON.stringify(canonical({ bindings, plexusLedger: owner === undefined ? {} : { ownerPrincipalId: owner } }));
}
export function authorizationDigest(config: unknown): string {
  return createHash("sha256").update(authorizationProjection(config)).digest("hex");
}
function reason(error: unknown): string {
  return error instanceof AuthorityError ? error.code : "authority_io_error";
}
async function loadState(dir: string): Promise<AuthorityState> {
  let value: unknown;
  try { value = JSON.parse(await readFile(join(dir, "state.json"), "utf8")); }
  catch (error) {
    throw new AuthorityError((error as NodeJS.ErrnoException).code === "ENOENT" ? "missing_state" : "corrupt_state");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AuthorityError("corrupt_state");
  const state = value as ObjectValue;
  if (state.format !== FORMAT) throw new AuthorityError("unknown_format");
  if (typeof state.revision !== "string" || !/^[1-9][0-9]{0,19}$/.test(state.revision)) throw new AuthorityError("invalid_revision");
  if (BigInt(state.revision) >= MAX_REVISION) throw new AuthorityError("revision_exhausted");
  if (typeof state.incarnation !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(state.incarnation) ||
      typeof state.digest !== "string" || !/^[0-9a-f]{64}$/.test(state.digest) ||
      typeof state.committedAt !== "string" || !Number.isFinite(Date.parse(state.committedAt))) throw new AuthorityError("corrupt_state");
  return state as unknown as AuthorityState;
}
export async function readAuthority(dir: string): Promise<AuthorityResult> {
  try {
    // Atomic rename gives each reader one complete committed state, never a journal intent or partial write.
    const { incarnation, revision, digest } = await loadState(dir);
    return { ok: true, incarnation, revision, digest };
  } catch (error) { return { ok: false, reason: reason(error) }; }
}
export async function verify(dir: string, config: unknown): Promise<AuthorityResult> {
  const state = await readAuthority(dir);
  if (!state.ok) return state;
  try {
    return state.digest === authorizationDigest(config) ? state : { ok: false, reason: "digest_mismatch" };
  } catch { return { ok: false, reason: "invalid_config" }; }
}
async function locked<T>(dir: string, action: () => Promise<T>): Promise<T> {
  try { await mkdir(dir, { recursive: true, mode: 0o700 }); }
  catch { throw new AuthorityError("authority_io_error"); }
  // The persistent inode is never unlinked. Kernel flock releases on exit; stdin EOF also releases after parent death.
  const child = spawn("flock", ["--exclusive", join(dir, "writer.lock"), process.execPath, "-e",
    'process.stdout.write("locked\\n"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0));'],
  { stdio: ["pipe", "pipe", "ignore"] });
  child.stdin.on("error", () => undefined);
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      child.once("error", () => reject(new AuthorityError("lock_unavailable")));
      child.once("exit", () => reject(new AuthorityError("lock_unavailable")));
      child.stdout.on("data", chunk => {
        output += chunk.toString();
        if (output.includes("locked\n")) resolve();
      });
    });
    return await action();
  } catch (error) { throw new AuthorityError(reason(error)); }
  finally { child.stdin.end(); await exited; }
}
function metadata(value: CommitMetadata): void {
  if (typeof value.actor !== "string" || !value.actor.trim() || typeof value.reason !== "string" || !value.reason.trim()) {
    throw new AuthorityError("invalid_metadata");
  }
}
async function publish(dir: string, state: AuthorityState, previousRevision: string | null, details: CommitMetadata): Promise<void> {
  const journal = await open(join(dir, "journal.jsonl"), "a", 0o600);
  try {
    await journal.writeFile(JSON.stringify({ incarnation: state.incarnation, revision: state.revision,
      previousRevision, digest: state.digest, actor: details.actor, reason: details.reason, at: state.committedAt }) + "\n");
    await journal.sync();
  } finally { await journal.close(); }
  const temporary = join(dir, `.state-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(state) + "\n"); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, join(dir, "state.json"));
    const directory = await open(dir, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temporary).catch(() => undefined); }
}
export async function init(dir: string): Promise<AuthorityState> {
  return locked(dir, async () => {
    try {
      await lstat(join(dir, "state.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const state: AuthorityState = { format: FORMAT, incarnation: randomUUID(), revision: "1",
        digest: UNCOMMITTED_DIGEST, committedAt: new Date().toISOString() };
      await publish(dir, state, null, { actor: "authority", reason: "initialize" });
      return state;
    }
    throw new AuthorityError("state_exists");
  });
}
export async function reincarnate(dir: string, details: { reason: string }): Promise<AuthorityState> {
  const info = { actor: "authority", reason: details.reason };
  metadata(info);
  return locked(dir, async () => {
    const previous = await readAuthority(dir);
    const state: AuthorityState = { format: FORMAT, incarnation: randomUUID(), revision: "1",
      digest: UNCOMMITTED_DIGEST, committedAt: new Date().toISOString() };
    await publish(dir, state, previous.ok ? previous.revision : null, info);
    return state;
  });
}
export async function commit(dir: string, configPath: string, details: CommitMetadata): Promise<AuthorityState> {
  metadata(details);
  return locked(dir, async () => {
    const previous = await loadState(dir);
    let digest: string;
    try { digest = authorizationDigest(JSON.parse(await readFile(configPath, "utf8"))); }
    catch { throw new AuthorityError("invalid_config"); }
    const state: AuthorityState = { format: FORMAT, incarnation: previous.incarnation,
      revision: (BigInt(previous.revision) + 1n).toString(), digest, committedAt: new Date().toISOString() };
    await publish(dir, state, previous.revision, details);
    return state;
  });
}
