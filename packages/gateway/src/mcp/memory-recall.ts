import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const GOVERNED_WRITE_RECORD_CONTRACT = "record must be an exact amf-memory/v1 object with schema, id, revision, claimType, scope, visibility, subjects, claim, confidence, lifecycle, provenance, createdAt, and updatedAt. New records use revision 1, expected_revision null, and lifecycle.supersedes []. scope.id is fixed to shared:global. claimType is fact, preference, event, decision, instruction, summary, or relationship. visibility is private, restricted, shared, or confidential. Use a sealed claim when the record or subjects are sensitive.";
const GOVERNED_WRITE_EXAMPLE = JSON.stringify({ schema: "amf-memory/v1", id: "mem_example_handoff_0001", revision: 1, claimType: "summary", scope: { type: "shared", id: "shared:global" }, visibility: "shared", subjects: [{ identityId: "agent:chatgpt-web", role: "owner" }], claim: { encoding: "plain", text: "Short handoff summary." }, confidence: { score: 0.8, basis: "asserted", assessedAt: "2026-01-01T00:00:00.000Z" }, lifecycle: { status: "active", validFrom: "2026-01-01T00:00:00.000Z", validTo: null, supersedes: [], revokedAt: null, revocationReason: null }, provenance: [{ sourceType: "chatgpt-web", sourceId: "durable-source-ref", eventId: "event_example_0001", contentSha256: "21a4b3360f5d340c7c3f1672669f5fcda06314959dfb4a78631ec751cc9f4709", capturedAt: "2026-01-01T00:00:00.000Z" }], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
const GOVERNED_WRITE_LARGE_DOCUMENT_GUIDANCE = "Large Markdown is not stored as a claim: when the proposal exceeds the server limit (default 32768 characters), store the full document durably and submit a bounded summary or instruction claim with its durable reference. proposal_too_large returns the actual limit and this remediation.";
const CANONICAL_RECORD_FIELDS = new Set(["schema", "id", "revision", "claimType", "scope", "visibility", "subjects", "claim", "confidence", "lifecycle", "provenance", "createdAt", "updatedAt", "record"]);

export interface MemoryRecallConfig {
  command: string;
  script: string;
  handoffDir: string;
  governedWrite?: boolean;
}

export type MemoryRecallTool = "memory_search" | "memory_read" | "memory_upsert" | "memory_proposal_status";

export class MemoryRecallError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "MemoryRecallError";
    this.code = code;
    this.details = details;
  }
}

export interface MemoryRecallRunner {
  readonly governedWrite: boolean;
  call(name: MemoryRecallTool, args: Record<string, unknown>): Promise<unknown>;
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
  readonly governedWrite: boolean;

  constructor(
    config: MemoryRecallConfig,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    execute: MemoryProcessExecutor = executeProcess
  ) {
    this.config = config;
    this.governedWrite = config.governedWrite === true;
    this.timeoutMs = timeoutMs;
    this.execute = execute;
  }

  async call(name: MemoryRecallTool, args: Record<string, unknown>): Promise<unknown> {
    const response = await this.rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args }
    });
    if (response.error !== undefined) throw bridgeError(response.error);
    const text = response.result?.content?.[0]?.text;
    if (typeof text !== "string") throw new MemoryRecallError("memory_upstream_invalid_response", "Memory response is invalid.",
      { retryable: true, action: "Retry the request; if it persists, report it to the AMF operator." });
    try { return JSON.parse(text); } catch { throw new MemoryRecallError("memory_upstream_invalid_response", "Memory response is invalid.",
      { retryable: true, action: "Retry the request; if it persists, report it to the AMF operator." }); }
  }

  async status(): Promise<"ready" | "degraded"> {
    try {
      const response = await this.rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const names = response.result?.tools?.map((tool: { name?: unknown }) => tool.name);
      const required = ["memory_search", "memory_read",
        ...(this.governedWrite ? ["memory_upsert", "memory_proposal_status"] : [])];
      return Array.isArray(names) && required.every((name) => names.includes(name))
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
    } catch { throw new MemoryRecallError("memory_upstream_unavailable", "Memory service is unavailable.",
      { retryable: true, action: "Retry the request after the memory service is available." }); }
    try { return JSON.parse(stdout.trim()); } catch { throw new MemoryRecallError("memory_upstream_invalid_response", "Memory response is invalid.",
      { retryable: true, action: "Retry the request; if it persists, report it to the AMF operator." }); }
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
  }, async (input) => toolResult(runner.call("memory_search", input)));

  server.registerTool("memory_read", {
    title: "Read canonical memory",
    description: "Reads one shared canonical memory by identifier without changing it.",
    annotations: readOnlyAnnotations,
    inputSchema: z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,191}$/) })
  }, async (input) => toolResult(runner.call("memory_read", input)));

  if (runner.governedWrite) {
    server.registerTool("memory_upsert", {
      title: "Propose canonical memory upsert",
      description: `Queues a revision-aware canonical memory proposal for AMF curation; it never writes canonical state directly. ${GOVERNED_WRITE_RECORD_CONTRACT} ${GOVERNED_WRITE_LARGE_DOCUMENT_GUIDANCE} Worked example: ${GOVERNED_WRITE_EXAMPLE}`,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        record: z.record(z.string(), z.unknown()).describe(`${GOVERNED_WRITE_RECORD_CONTRACT} Example: ${GOVERNED_WRITE_EXAMPLE}`),
        rationale: z.string().min(1).max(4096),
        expected_revision: z.number().int().min(0).nullable(),
        idempotency_key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,191}$/)
      })
    }, async (input) => toolResult(runner.call("memory_upsert", {
      record: input.record, rationale: input.rationale, expectedRevision: input.expected_revision,
      idempotencyKey: input.idempotency_key
    })));

    server.registerTool("memory_proposal_status", {
      title: "Read memory proposal status",
      description: "Reads the lifecycle status of a governed AMF proposal.",
      annotations: readOnlyAnnotations,
      inputSchema: z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,191}$/) })
    }, async (input) => toolResult(runner.call("memory_proposal_status", input)));
  }
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

async function toolResult(value: Promise<unknown>) {
  try { return result(await value); }
  catch (error) { return errorResult(error); }
}

function bridgeError(value: unknown): MemoryRecallError {
  const error = isRecord(value) ? value : {};
  const data = isRecord(error.data) ? error.data : {};
  const code = typeof data.code === "string" ? data.code : "memory_upstream_failed";
  if (code === "canonical_record_invalid") {
    return new MemoryRecallError(code, "Invalid governed memory record.", {
      fields: boundedFields(data.fields),
      action: "Use the published amf-memory/v1 record template and supply every required field."
    });
  }
  if (code === "proposal_too_large") {
    return new MemoryRecallError(code, "Governed memory proposal is too large.", {
      ...positiveInteger(data.maxChars, "maxChars"), ...positiveInteger(data.observedChars, "observedChars"),
      strategy: "summary_plus_pointer",
      action: "Store the full document durably, then submit a bounded summary or instruction claim with a durable reference."
    });
  }
  if (code === "memory_upstream_unavailable" || code === "memory_upstream_invalid_response" || code === "memory_upstream_failed") {
    return new MemoryRecallError(code, code === "memory_upstream_unavailable" ? "Memory service is unavailable." : "Memory request failed.", {
      retryable: data.retryable === true,
      action: typeof data.action === "string" && data.action.length <= 256 ? data.action : "Retry the request; if it persists, report it to the AMF operator."
    });
  }
  return new MemoryRecallError("memory_upstream_failed", "Memory request failed.", {
    retryable: false,
    action: "Check the governed record contract or request status, then retry with a corrected request."
  });
}

function errorResult(error: unknown) {
  const failure = error instanceof MemoryRecallError ? error : new MemoryRecallError("memory_request_failed", "Memory request failed.", {
    retryable: false,
    action: "Retry the request; if it persists, report it to the AMF operator."
  });
  const payload = { error: { code: failure.code, ...failure.details } };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedFields(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((field): field is string => typeof field === "string" && CANONICAL_RECORD_FIELDS.has(field)))].slice(0, 12);
}

function positiveInteger(value: unknown, key: string): Record<string, number> {
  return Number.isSafeInteger(value) && (value as number) > 0 ? { [key]: value as number } : {};
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
