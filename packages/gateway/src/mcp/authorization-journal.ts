import { createHash } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { resolveCloudflareAccessPrincipal, type CloudflareAccessBinding } from "./cloudflare-access.js";
import type { MeshMcpPrincipal } from "./mesh-mcp.js";

export interface AuthorizationPolicy {
  bindings: CloudflareAccessBinding[];
  ownerPrincipalId: string;
}

interface AuthorizationEntry extends AuthorizationPolicy {
  revision: number;
  revokedAssertions: string[];
}

/** Hashes are local revocation identifiers, never bearer credentials. */
export function assertionDigest(assertion: string): string {
  return createHash("sha256").update(assertion).digest("hex");
}

/**
 * Append-only authorization authority. All policy changes, including restores,
 * use replace() with CAS. The journal is never rolled back with runtime config.
 * Missing, partial, malformed or regressed history fails closed.
 */
export class AuthorizationJournal {
  private highestRevision = 0;
  private highestEntry = "";

  private readonly path: string;

  constructor(path: string) { this.path = path; }

  private async entries(): Promise<AuthorizationEntry[]> {
    let bytes: string;
    try { bytes = await readFile(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && this.highestRevision === 0) return [];
      throw error;
    }
    if (!bytes.endsWith("\n")) throw new Error("Incomplete authorization journal.");
    const entries = bytes.slice(0, -1).split("\n").map(line => JSON.parse(line) as AuthorizationEntry);
    let previous: AuthorizationEntry | undefined;
    for (const [index, entry] of entries.entries()) {
      if (entry.revision !== index + 1 || !Number.isSafeInteger(entry.revision) ||
          !Array.isArray(entry.bindings) || typeof entry.ownerPrincipalId !== "string" || !entry.ownerPrincipalId ||
          !Array.isArray(entry.revokedAssertions) || entry.revokedAssertions.some(hash => !/^[a-f0-9]{64}$/.test(hash)) ||
          previous?.revokedAssertions.some(hash => !entry.revokedAssertions.includes(hash))) {
        throw new Error("Invalid authorization history.");
      }
      previous = entry;
    }
    if (entries.length < this.highestRevision || (this.highestRevision > 0 &&
        JSON.stringify(entries[this.highestRevision - 1]) !== this.highestEntry)) {
      throw new Error("Authorization history regressed.");
    }
    if (previous) {
      this.highestRevision = previous.revision;
      this.highestEntry = JSON.stringify(previous);
    }
    return entries;
  }

  async resolvePrincipal(auth: AuthInfo): Promise<MeshMcpPrincipal> {
    const entry = (await this.entries()).at(-1);
    if (!entry || entry.revokedAssertions.includes(assertionDigest(auth.token))) {
      throw new Error("Authorization unavailable.");
    }
    return { ...resolveCloudflareAccessPrincipal(auth, entry.bindings, entry.ownerPrincipalId),
      authorizationRevision: entry.revision };
  }

  /** No retries or lock takeover. A failed/partial append must be investigated. */
  async replace(expectedRevision: number, policy: AuthorizationPolicy, revokeAssertionDigests: string[] = []): Promise<number> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
        !Array.isArray(policy.bindings) || typeof policy.ownerPrincipalId !== "string" || !policy.ownerPrincipalId ||
        revokeAssertionDigests.some(hash => !/^[a-f0-9]{64}$/.test(hash))) throw new Error("Invalid authorization update.");
    const lock = await open(`${this.path}.lock`, "wx", 0o600);
    try {
      const previous = (await this.entries()).at(-1);
      if ((previous?.revision ?? 0) !== expectedRevision || expectedRevision === Number.MAX_SAFE_INTEGER) {
        throw new Error("Authorization revision conflict.");
      }
      const entry: AuthorizationEntry = { ...policy, revision: expectedRevision + 1,
        revokedAssertions: [...new Set([...(previous?.revokedAssertions ?? []), ...revokeAssertionDigests])] };
      const output = await open(this.path, "a", 0o600);
      try { await output.writeFile(`${JSON.stringify(entry)}\n`); await output.sync(); }
      finally { await output.close(); }
      const directory = await open(dirname(this.path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
      return entry.revision;
    } finally {
      await lock.close();
      await unlink(`${this.path}.lock`);
    }
  }
}
