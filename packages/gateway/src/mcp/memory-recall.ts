import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

export interface MemoryRecallConfig {
  command: string;
  script: string;
  handoffDir: string;
}

export interface MemoryRecallRunner {
  call(name: "memory_search" | "memory_read", args: Record<string, unknown>): Promise<unknown>;
  status(): Promise<"ready" | "degraded">;
}

export type MemoryProcessExecutor = (
  command: string,
  args: readonly string[],
  input: string,
  options: SpawnOptionsWithoutStdio & { timeoutMs: number; maxOutputBytes: number }
) => Promise<string>;

export class StdioMemoryRecallRunner implements MemoryRecallRunner {
  private readonly config: MemoryRecallConfig;
  private readonly timeoutMs: number;
  private readonly execute: MemoryProcessExecutor;

  constructor(
    config: MemoryRecallConfig,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    execute: MemoryProcessExecutor = executeProcess
  ) {
    this.config = config;
    this.timeoutMs = timeoutMs;
    this.execute = execute;
  }

  async call(name: "memory_search" | "memory_read", args: Record<string, unknown>): Promise<unknown> {
    const response = await this.rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args }
    });
    if (response.error !== undefined) throw new Error("Memory request failed.");
    const text = response.result?.content?.[0]?.text;
    if (typeof text !== "string") throw new Error("Memory response is invalid.");
    try { return JSON.parse(text); } catch { throw new Error("Memory response is invalid."); }
  }

  async status(): Promise<"ready" | "degraded"> {
    try {
      const response = await this.rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const names = response.result?.tools?.map((tool: { name?: unknown }) => tool.name);
      return Array.isArray(names) && names.includes("memory_search") && names.includes("memory_read")
        ? "ready"
        : "degraded";
    } catch { return "degraded"; }
  }

  private async rpc(message: Record<string, unknown>): Promise<any> {
    let stdout: string;
    try {
      stdout = await this.execute(
        this.config.command,
        [this.config.script],
        `${JSON.stringify(message)}\n`,
        {
          env: { ...process.env, AMF_INTERACTIVE_RECALL_HANDOFF_DIR: this.config.handoffDir },
          windowsHide: true,
          timeoutMs: this.timeoutMs,
          maxOutputBytes: MAX_OUTPUT_BYTES
        }
      );
    } catch { throw new Error("Memory request failed."); }
    try { return JSON.parse(stdout.trim()); } catch { throw new Error("Memory response is invalid."); }
  }
}

export function registerMemoryRecallTools(server: McpServer, runner: MemoryRecallRunner): void {
  server.registerTool("memory_search", {
    title: "Search canonical memory",
    description: "Searches shared canonical memories without changing them.",
    annotations: readOnlyAnnotations,
    inputSchema: z.object({
      query: z.string().min(1).max(4096),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().nullable().optional(),
      from: z.string().nullable().optional(),
      to: z.string().nullable().optional()
    })
  }, async (input) => result(await runner.call("memory_search", input)));

  server.registerTool("memory_read", {
    title: "Read canonical memory",
    description: "Reads one shared canonical memory by identifier without changing it.",
    annotations: readOnlyAnnotations,
    inputSchema: z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,191}$/) })
  }, async (input) => result(await runner.call("memory_read", input)));
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: { results: value }
  };
}

function executeProcess(
  command: string,
  args: readonly string[],
  input: string,
  options: SpawnOptionsWithoutStdio & { timeoutMs: number; maxOutputBytes: number }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { ...options, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = []; let size = 0; let settled = false;
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error("timeout")); }, options.timeoutMs);
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error !== undefined) reject(error); else resolve(Buffer.concat(stdout).toString("utf8"));
    };
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > options.maxOutputBytes) { child.kill("SIGKILL"); finish(new Error("output_limit")); }
      else stdout.push(chunk);
    });
    child.once("error", finish);
    child.once("close", (code) => finish(code === 0 ? undefined : new Error("process_failed")));
    child.stdin.end(input);
  });
}
