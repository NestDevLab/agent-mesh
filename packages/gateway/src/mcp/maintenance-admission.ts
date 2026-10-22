import { randomUUID } from "node:crypto";
import { constants, fchmodSync, lstatSync, openSync, readFileSync, closeSync, writeFileSync, fsyncSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export const ADMISSION_PROTOCOL = "agent-mesh.admission.v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
interface Marker { protocol: typeof ADMISSION_PROTOCOL; owner: string }

/** Private local control plane. Filesystem errors always leave admission closed. */
export class MaintenanceAdmission {
  readonly socketPath: string;
  private readonly markerPath: string;
  private marker?: Marker;
  private paused = true;
  private inflightRequests = 0;
  private server?: Server;
  private socketIdentity?: { dev: number; ino: number };
  private tail: Promise<unknown> = Promise.resolve();

  private readonly stateDir: string;
  private readonly countTasks: () => Promise<number>;

  constructor(stateDir: string, countTasks: () => Promise<number>) {
    this.stateDir = stateDir;
    this.countTasks = countTasks;
    this.socketPath = join(stateDir, "maintenance-admission.sock");
    this.markerPath = join(stateDir, "maintenance-admission.json");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.marker = this.readMarker();
  }

  private readMarker(): Marker | undefined {
    let info;
    try { info = lstatSync(this.markerPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (!info.isFile() || (info.mode & 0o777) !== 0o600) throw new Error("Unsafe admission marker.");
    const fd = openSync(this.markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const value = JSON.parse(readFileSync(fd, "utf8"));
      if (value?.protocol !== ADMISSION_PROTOCOL || typeof value.owner !== "string" || !UUID.test(value.owner) || Object.keys(value).length !== 2) throw new Error("Invalid admission marker.");
      return value;
    } finally { closeSync(fd); }
  }

  private syncDirectory(): void {
    const fd = openSync(this.stateDir, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }

  private persist(marker: Marker): void {
    const temporary = `${this.markerPath}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { fchmodSync(fd, 0o600); writeFileSync(fd, `${JSON.stringify(marker)}\n`); fsyncSync(fd); }
    finally { closeSync(fd); }
    try { renameSync(temporary, this.markerPath); this.syncDirectory(); }
    finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  }

  async start(): Promise<void> {
    // Never unlink a live socket, a symlink, or an unrelated filesystem entry.
    try {
      const before = await lstat(this.socketPath);
      if (!before.isSocket()) throw new Error("Unsafe admission socket path.");
      await new Promise<void>((resolve, reject) => {
        const probe = createConnection(this.socketPath);
        probe.once("connect", () => { probe.destroy(); reject(new Error("Admission socket is already live.")); });
        probe.once("error", (error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED" ? resolve() : reject(error));
        probe.setTimeout(1000, () => { probe.destroy(); reject(new Error("Admission socket liveness unknown.")); });
      });
      const after = await lstat(this.socketPath);
      if (before.dev !== after.dev || before.ino !== after.ino) throw new Error("Admission socket changed during probe.");
      await unlink(this.socketPath);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const server = createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.setTimeout(5000, () => socket.destroy());
      socket.on("error", () => undefined);
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.length > 8192) { socket.destroy(); return; }
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          const result = this.tail.then(() => this.command(line));
          this.tail = result.catch(() => undefined);
          void result.then((value) => socket.write(`${JSON.stringify(value)}\n`), (error) => socket.write(`${JSON.stringify({ ok: false, protocol: ADMISSION_PROTOCOL, error: String(error) })}\n`));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // Unix bind is synchronous; restrict permissions from the moment the inode exists.
      const priorMask = process.umask(0o177);
      try { server.listen(this.socketPath, () => { server.off("error", reject); resolve(); }); }
      finally { process.umask(priorMask); }
    });
    this.server = server;
    try {
      await chmod(this.socketPath, 0o600);
      this.socketIdentity = await lstat(this.socketPath);
      this.paused = this.marker !== undefined;
    } catch (error) { await this.close(); throw error; }
  }

  private async command(line: string) {
    const request = JSON.parse(line);
    if (!request || !["status", "pause", "resume"].includes(request.operation) || typeof request.owner !== "string" || !UUID.test(request.owner)) throw new Error("Invalid admission command.");
    let nonterminalTasks: number | undefined;
    if (request.operation !== "status") {
      // Close synchronously before any asynchronous operation or persistence attempt.
      if (request.operation === "pause") this.paused = true;
      let disk: Marker | undefined;
      try { disk = this.readMarker(); } catch (error) { this.paused = true; throw error; }
      if (disk !== undefined && disk.owner !== request.owner) throw new Error("Admission owner mismatch.");
      if (this.marker !== undefined && this.marker.owner !== request.owner) throw new Error("Admission owner mismatch.");
      if (request.operation === "pause") {
        const marker: Marker = { protocol: ADMISSION_PROTOCOL, owner: request.owner };
        this.persist(marker); this.marker = marker;
      } else {
        if (disk === undefined || this.marker?.owner !== request.owner) throw new Error("No matching admission lease.");
        nonterminalTasks = await this.countTasks();
        unlinkSync(this.markerPath); this.syncDirectory(); this.marker = undefined; this.paused = false;
      }
    }
    return { ok: true, protocol: ADMISSION_PROTOCOL, paused: this.paused, owner: this.marker?.owner ?? null, pid: process.pid, inflightRequests: this.inflightRequests, nonterminalTasks: nonterminalTasks ?? await this.countTasks() };
  }

  /** Check and increment in one event-loop turn, before parsing or dispatching any route. */
  handle(request: IncomingMessage, response: ServerResponse, execute: () => Promise<void>): void {
    this.inflightRequests++;
    let executionSettled = false;
    let responseSettled = false;
    let released = false;
    const release = () => {
      if (!released && executionSettled && responseSettled) { released = true; this.inflightRequests--; }
    };
    const responseDone = () => {
      responseSettled = true;
      response.off("finish", responseDone); response.off("close", responseDone);
      release();
    };
    response.once("finish", responseDone); response.once("close", responseDone);
    if (this.paused) {
      executionSettled = true;
      response.writeHead(503, { "content-type": "application/json", "connection": "close" });
      response.end(JSON.stringify({ error: "Gateway admission paused for maintenance." }));
      return;
    }
    void Promise.resolve().then(execute)
      .catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); })
      .finally(() => { executionSettled = true; release(); });
  }

  async close(): Promise<void> {
    this.paused = true;
    if (this.server !== undefined) {
      // Control connections must be short-lived; clients close after their response.
      await new Promise<void>((resolve, reject) => this.server!.close((error) => error ? reject(error) : resolve()));
      this.server = undefined;
      try {
        const current = await lstat(this.socketPath);
        if (current.dev === this.socketIdentity?.dev && current.ino === this.socketIdentity.ino) await unlink(this.socketPath);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
}
