import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { env as processEnv } from "node:process";

import { ShellTmuxSender, type ShellRun } from "./shell-tmux-sender.js";
import type { TmuxSendResult } from "./tmux-transport-adapter.js";

export type AgentSessionStatus = "discovered" | "busy" | "unavailable";

export interface AgentSessionSummary {
  session_id: string;
  agent_id: string;
  provider: "codex" | "claude";
  workspace_id: string;
  status: AgentSessionStatus;
  updated_at: string;
}

export interface AgentSessionPage {
  sessions: readonly AgentSessionSummary[];
  next_cursor: string | null;
}

export interface AgentTranscriptEvent {
  event_id: string;
  role: "user" | "assistant";
  timestamp: string | null;
  text: string;
}

export interface AgentTranscriptPage {
  session_id: string;
  agent_id: string;
  provider: "codex" | "claude";
  workspace_id: string;
  events: readonly AgentTranscriptEvent[];
  next_cursor: string | null;
}

export interface AgentSessionSearchResult extends AgentSessionSummary {
  matches: readonly AgentTranscriptEvent[];
}

export interface AgentSessionSearchPage {
  results: readonly AgentSessionSearchResult[];
  next_cursor: string | null;
}

export interface AgentSessionSendInput {
  sessionId: string;
  workspaceId: string;
  message: string;
  messageId: string;
  contextId: string;
  taskId?: string;
  correlationId?: string;
  idempotencyKey: string;
}

export interface AgentSessionProvider {
  readonly agentId: string;
  readonly provider: "codex" | "claude";
  list(input: { workspaceId: string; cursor?: string; limit: number }): Promise<AgentSessionPage>;
  get(input: { workspaceId: string; sessionId: string }): Promise<AgentSessionSummary | undefined>;
  transcript(input: { workspaceId: string; sessionId: string; cursor?: string; limit: number }): Promise<AgentTranscriptPage | undefined>;
  search(input: { workspaceId: string; query: string; cursor?: string; limit: number }): Promise<AgentSessionSearchPage>;
  send(input: AgentSessionSendInput): Promise<TmuxSendResult>;
}

export class AgentSessionRegistry {
  private readonly providers = new Map<string, AgentSessionProvider>();

  constructor(providers: readonly AgentSessionProvider[]) {
    for (const provider of providers) {
      if (this.providers.has(provider.agentId)) {
        throw new Error(`Duplicate session provider for agent: ${provider.agentId}`);
      }
      this.providers.set(provider.agentId, provider);
    }
  }

  has(agentId: string): boolean {
    return this.providers.has(agentId);
  }

  list(agentId: string, input: { workspaceId: string; cursor?: string; limit: number }): Promise<AgentSessionPage> {
    return this.require(agentId).list(input);
  }

  get(agentId: string, input: { workspaceId: string; sessionId: string }): Promise<AgentSessionSummary | undefined> {
    return this.require(agentId).get(input);
  }

  transcript(agentId: string, input: { workspaceId: string; sessionId: string; cursor?: string; limit: number }): Promise<AgentTranscriptPage | undefined> {
    return this.require(agentId).transcript(input);
  }

  search(agentId: string, input: { workspaceId: string; query: string; cursor?: string; limit: number }): Promise<AgentSessionSearchPage> {
    return this.require(agentId).search(input);
  }

  send(agentId: string, input: AgentSessionSendInput): Promise<TmuxSendResult> {
    return this.require(agentId).send(input);
  }

  private require(agentId: string): AgentSessionProvider {
    const provider = this.providers.get(agentId);
    if (provider === undefined) throw new Error(`Agent session access is not configured: ${agentId}`);
    return provider;
  }
}

interface BridgeSession {
  session_id: string;
  agent_type: string;
  cwd: string;
  updated_at: string;
}

interface BridgeSessionResponse {
  agent_type: string;
  sessions: BridgeSession[];
}

interface BridgeTranscriptResponse {
  agent_type: string;
  session_id: string;
  events: AgentTranscriptEvent[];
  next_cursor: number | null;
}

interface BridgeSearchResult {
  agent_type: string;
  session_id: string;
  cwd: string;
  updated_at: string;
  matches: AgentTranscriptEvent[];
}

interface BridgeSearchResponse {
  agent_type: string;
  results: BridgeSearchResult[];
  next_cursor: number | null;
}

export interface ShellAgentSessionProviderOptions {
  agentId: string;
  agentType: "codex" | "claude";
  agentSessionPath: string;
  agentSendPath: string;
  agentNativeCallPath?: string;
  agentManagedInboxRoot?: string;
  workspaceRoots: Readonly<Record<string, readonly string[]>>;
  meshSocket?: string;
  timeoutSeconds?: number;
  scanLimit?: number;
  run?: ShellRun;
}

/** Host-owned bridge over the existing agent-session.sh and agent-send.sh contract. */
export class ShellAgentSessionProvider implements AgentSessionProvider {
  readonly agentId: string;
  readonly provider: "codex" | "claude";

  private readonly agentSessionPath: string;
  private readonly workspaceRoots: Readonly<Record<string, readonly string[]>>;
  private readonly scanLimit: number;
  private readonly meshSocket?: string;
  private readonly agentNativeCallPath?: string;
  private readonly agentManagedInboxRoot?: string;
  private readonly timeoutSeconds: number;
  private readonly run: ShellRun;
  private readonly sender: ShellTmuxSender;
  private readonly sendQueues = new Map<string, Promise<void>>();

  constructor(options: ShellAgentSessionProviderOptions) {
    this.agentId = options.agentId;
    this.provider = options.agentType;
    this.agentSessionPath = options.agentSessionPath;
    this.workspaceRoots = Object.fromEntries(
      Object.entries(options.workspaceRoots).map(([workspaceId, roots]) => [workspaceId, roots.map((root) => resolve(root))])
    );
    this.scanLimit = options.scanLimit ?? 500;
    this.meshSocket = options.meshSocket;
    this.agentNativeCallPath = options.agentNativeCallPath;
    this.agentManagedInboxRoot = options.agentManagedInboxRoot;
    this.timeoutSeconds = options.timeoutSeconds ?? 120;
    this.run = options.run ?? defaultRun;
    this.sender = new ShellTmuxSender({
      agentSendPath: options.agentSendPath,
      agentType: options.agentType,
      timeoutSeconds: options.timeoutSeconds,
      meshSocket: options.meshSocket,
      run: this.run
    });
  }

  async list(input: { workspaceId: string; cursor?: string; limit: number }): Promise<AgentSessionPage> {
    const roots = this.roots(input.workspaceId);
    const response = await this.command(["--agent", this.provider, "list", "--json", "--limit", String(this.scanLimit)]);
    const parsed = parseBridgeSessions(response.stdout, this.provider);
    const matching = parsed.sessions
      .filter((session) => roots.some((root) => isWithin(session.cwd, root)))
      .map((session) => this.summary(session, input.workspaceId));
    const offset = decodeCursor(input.cursor);
    const sessions = matching.slice(offset, offset + input.limit);
    const next = offset + sessions.length;
    return {
      sessions,
      next_cursor: next < matching.length ? encodeCursor(next) : null
    };
  }

  async get(input: { workspaceId: string; sessionId: string }): Promise<AgentSessionSummary | undefined> {
    const roots = this.roots(input.workspaceId);
    const response = await this.command([
      "--agent", this.provider, "inspect", input.sessionId, "--json"
    ], true);
    if (response.code === 3) return undefined;
    if (response.code !== 0) throw new Error(safeProcessError("Agent session inspection failed", response));
    const session = parseBridgeSessions(response.stdout, this.provider).sessions[0];
    if (session === undefined || !roots.some((root) => isWithin(session.cwd, root))) return undefined;
    return this.summary(session, input.workspaceId);
  }

  async transcript(input: { workspaceId: string; sessionId: string; cursor?: string; limit: number }): Promise<AgentTranscriptPage | undefined> {
    const session = await this.get({ workspaceId: input.workspaceId, sessionId: input.sessionId });
    if (session === undefined) return undefined;
    const offset = decodeCursor(input.cursor);
    const response = await this.command([
      "--agent", this.provider, "transcript", input.sessionId, "--json",
      "--cursor", String(offset), "--limit", String(input.limit)
    ], true);
    if (response.code === 3) return undefined;
    if (response.code !== 0) throw new Error(safeProcessError("Agent transcript read failed", response));
    const parsed = parseBridgeTranscript(response.stdout, this.provider, input.sessionId);
    return {
      session_id: input.sessionId,
      agent_id: this.agentId,
      provider: this.provider,
      workspace_id: input.workspaceId,
      events: parsed.events,
      next_cursor: parsed.next_cursor === null ? null : encodeCursor(parsed.next_cursor)
    };
  }

  async search(input: { workspaceId: string; query: string; cursor?: string; limit: number }): Promise<AgentSessionSearchPage> {
    const roots = this.roots(input.workspaceId);
    let candidateCursor = decodeCursor(input.cursor);
    const results: AgentSessionSearchResult[] = [];
    let nextCursor: number | null = candidateCursor;
    while (results.length < input.limit && nextCursor !== null) {
      const response = await this.command([
        "--agent", this.provider, "search", input.query, "--json",
        "--cursor", String(candidateCursor), "--limit", String(input.limit - results.length),
        "--scan-limit", String(this.scanLimit)
      ]);
      const parsed = parseBridgeSearch(response.stdout, this.provider);
      for (const item of parsed.results) {
        if (!roots.some((root) => isWithin(item.cwd, root))) continue;
        results.push({
          session_id: item.session_id,
          agent_id: this.agentId,
          provider: this.provider,
          workspace_id: input.workspaceId,
          status: "discovered",
          updated_at: item.updated_at,
          matches: item.matches
        });
      }
      nextCursor = parsed.next_cursor;
      if (nextCursor !== null && nextCursor <= candidateCursor) {
        throw new Error("Agent transcript search bridge returned a non-advancing cursor.");
      }
      if (nextCursor !== null) candidateCursor = nextCursor;
    }
    return { results, next_cursor: nextCursor === null ? null : encodeCursor(nextCursor) };
  }

  async send(input: AgentSessionSendInput): Promise<TmuxSendResult> {
    const queueKey = `${input.workspaceId}:${input.sessionId}`;
    const prior = this.sendQueues.get(queueKey) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolveCurrent) => { release = resolveCurrent; });
    const tail = prior.then(() => current);
    this.sendQueues.set(queueKey, tail);
    await prior;
    try {
      return await this.sendUnlocked(input);
    } finally {
      release();
      if (this.sendQueues.get(queueKey) === tail) this.sendQueues.delete(queueKey);
    }
  }

  private async sendUnlocked(input: AgentSessionSendInput): Promise<TmuxSendResult> {
    const session = await this.get({ workspaceId: input.workspaceId, sessionId: input.sessionId });
    if (session === undefined) {
      return { ok: false, error: "Session is not available in the authorized workspace." };
    }
    const writerStatus = await this.command([
      "--agent", this.provider, "writer-status", input.sessionId, "--json"
    ], true);
    if (writerStatus.code !== 0) {
      return { ok: false, error: safeProcessError("Agent session writer inspection failed", writerStatus) };
    }
    const writers = parseWriterStatus(writerStatus.stdout, this.provider, input.sessionId);
    if (writers.length > 0) {
      if (this.agentNativeCallPath !== undefined) {
        if (input.correlationId === undefined) {
          return { ok: false, error: "A correlation ID is required for an active Codex session call." };
        }
        const nativeArgs = [
          this.agentNativeCallPath,
          "--agent", this.provider,
          "--session", input.sessionId,
          "--correlation-id", input.correlationId,
          "--timeout", String(this.timeoutSeconds),
          "--message", input.message
        ];
        if (this.provider === "claude" && this.agentManagedInboxRoot !== undefined) {
          nativeArgs.push("--managed-inbox-root", this.agentManagedInboxRoot);
        }
        const result = await this.run(process.execPath, nativeArgs, {
          env: { ...processEnv },
          timeoutMs: (this.timeoutSeconds + 20) * 1000
        });
        return nativeCallResult(result);
      }
      return {
        ok: false,
        ...(this.provider === "claude" ? { error_code: "active_external_writer" as const } : {}),
        error: this.provider === "claude"
          ? "Claude session already has an active writer; no safe native queue transport is configured."
          : "Session already has an active writer."
      };
    }

    const resumed = await this.command(["--agent", this.provider, "resume", input.sessionId], true);
    if (resumed.code !== 0) {
      return {
        ok: false,
        error: resumed.code === 4
          ? "Session already has an active writer."
          : safeProcessError("Agent session resume failed", resumed)
      };
    }
    const tmuxTarget = resumed.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (tmuxTarget === undefined) return { ok: false, error: "Agent session resume returned no tmux target." };
    return this.sender.send({
      target_agent_id: this.agentId,
      tmux_target: tmuxTarget,
      prompt: input.message,
      message_id: input.messageId,
      context_id: input.contextId,
      task_id: input.taskId,
      correlation_id: input.correlationId,
      idempotency_key: input.idempotencyKey
    });
  }

  private roots(workspaceId: string): readonly string[] {
    const roots = this.workspaceRoots[workspaceId];
    if (roots === undefined || roots.length === 0) {
      throw new Error(`Agent session workspace is not configured: ${workspaceId}`);
    }
    return roots;
  }

  private summary(session: BridgeSession, workspaceId: string): AgentSessionSummary {
    return {
      session_id: session.session_id,
      agent_id: this.agentId,
      provider: this.provider,
      workspace_id: workspaceId,
      // Discovery proves durable session metadata and workspace ownership, not
      // writer availability. The provider-specific resume command performs the
      // live writer check immediately before sending.
      status: "discovered",
      updated_at: session.updated_at
    };
  }

  private async command(args: readonly string[], allowFailure = false) {
    const env = { ...processEnv };
    if (this.meshSocket !== undefined) env.MESH_TMUX_SOCKET = this.meshSocket;
    if (args.includes("resume")) {
      env.MESH_STRICT_READY = "1";
      env.MESH_PRESERVE_SESSION_POLICY = "1";
      env.MESH_REPLACE_UNREADY_SESSION = "1";
    }
    const response = await this.run(this.agentSessionPath, args, {
      env,
      // A cold resume waits up to 30 seconds for the provider TUI to become
      // ready; keep the host ceiling above that bridge-owned bound.
      timeoutMs: 45_000
    });
    if (!allowFailure && response.code !== 0) {
      throw new Error(safeProcessError("Agent session command failed", response));
    }
    return response;
  }
}

interface WriterStatusResponse {
  agent: string;
  sessionId: string;
  writers: Array<{ pid: number; kind: string }>;
}

function parseWriterStatus(value: string, expectedAgent: string, expectedSessionId: string) {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error("Agent session writer bridge returned invalid JSON."); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Agent session writer bridge returned an invalid payload.");
  }
  const candidate = parsed as Partial<WriterStatusResponse>;
  if (
    candidate.agent !== expectedAgent ||
    candidate.sessionId !== expectedSessionId ||
    !Array.isArray(candidate.writers) ||
    candidate.writers.some((writer) => (
      typeof writer !== "object" || writer === null ||
      !Number.isInteger(writer.pid) || typeof writer.kind !== "string"
    ))
  ) throw new Error("Agent session writer bridge returned malformed metadata.");
  return candidate.writers;
}

function validTranscriptEvent(value: unknown): value is AgentTranscriptEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Partial<AgentTranscriptEvent>;
  return typeof event.event_id === "string" &&
    (event.role === "user" || event.role === "assistant") &&
    (event.timestamp === null || typeof event.timestamp === "string") &&
    typeof event.text === "string";
}

function parseBridgeTranscript(value: string, expectedAgent: string, expectedSessionId: string): BridgeTranscriptResponse {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error("Agent transcript bridge returned invalid JSON."); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Agent transcript bridge returned an invalid payload.");
  }
  const candidate = parsed as Partial<BridgeTranscriptResponse>;
  if (
    candidate.agent_type !== expectedAgent || candidate.session_id !== expectedSessionId ||
    !Array.isArray(candidate.events) || candidate.events.some((event) => !validTranscriptEvent(event)) ||
    (candidate.next_cursor !== null && (!Number.isSafeInteger(candidate.next_cursor) || Number(candidate.next_cursor) < 0))
  ) throw new Error("Agent transcript bridge returned malformed metadata.");
  return candidate as BridgeTranscriptResponse;
}

function parseBridgeSearch(value: string, expectedAgent: string): BridgeSearchResponse {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error("Agent transcript search bridge returned invalid JSON."); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Agent transcript search bridge returned malformed metadata.");
  }
  const response = parsed as Partial<BridgeSearchResponse>;
  if (response.agent_type !== expectedAgent || !Array.isArray(response.results) || response.results.some((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return true;
    const candidate = item as Partial<BridgeSearchResult>;
    return candidate.agent_type !== expectedAgent || typeof candidate.session_id !== "string" ||
      typeof candidate.cwd !== "string" || typeof candidate.updated_at !== "string" ||
      !Array.isArray(candidate.matches) || candidate.matches.some((event) => !validTranscriptEvent(event));
  }) || (response.next_cursor !== null && (!Number.isSafeInteger(response.next_cursor) || Number(response.next_cursor) < 0))) {
    throw new Error("Agent transcript search bridge returned malformed metadata.");
  }
  return response as BridgeSearchResponse;
}

function nativeCallResult(result: { code: number; stdout: string; stderr: string }): TmuxSendResult {
  if (result.code === 0) return { ok: true, reply: result.stdout.trim() };
  const detail = result.stderr.trim().split(/\r?\n/).at(-1);
  const suffix = detail ? `: ${detail}` : "";
  if (result.code === 65) return { ok: true, result_error_code: "result_no_output", error: `Agent produced no textual result${suffix}` };
  if (result.code === 66) return { ok: true, result_error_code: "result_uncorrelated", error: `Agent output was not correlated${suffix}` };
  if (result.code === 67) return { ok: true, result_error_code: "result_parsing_failure", error: `Agent result parsing failed${suffix}` };
  if (result.code === 124) return { ok: true, result_error_code: "result_timeout", error: `Agent result collection timed out${suffix}` };
  if (result.code === 78) return { ok: false, error_code: "active_external_writer", error: "Claude session is active but is not owned by the configured managed transport." };
  if (result.code === 79) return { ok: false, error_code: "session_interaction_unsupported", error: "Codex spawned sub-agent sessions are readable but do not accept direct queued turns." };
  return { ok: false, error: `Agent native session call failed${suffix}` };
}

function parseBridgeSessions(value: string, expectedAgent: string): BridgeSessionResponse {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error("Agent session bridge returned invalid JSON."); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Agent session bridge returned an invalid payload.");
  }
  const candidate = parsed as Partial<BridgeSessionResponse>;
  if (candidate.agent_type !== expectedAgent || !Array.isArray(candidate.sessions)) {
    throw new Error("Agent session bridge returned an unexpected agent type.");
  }
  for (const session of candidate.sessions) {
    if (
      typeof session.session_id !== "string" ||
      typeof session.cwd !== "string" ||
      typeof session.updated_at !== "string"
    ) throw new Error("Agent session bridge returned malformed session metadata.");
  }
  return candidate as BridgeSessionResponse;
}

function isWithin(cwd: string, root: string): boolean {
  const normalized = resolve(cwd);
  const rel = relative(root, normalized);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const value = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid agent session cursor.");
  return value;
}

function safeProcessError(prefix: string, result: { code: number; stderr: string }): string {
  const detail = result.stderr.trim().split(/\r?\n/).at(-1);
  return detail ? `${prefix}: ${detail}` : `${prefix}: exit ${result.code}`;
}

function defaultRun(
  command: string,
  args: readonly string[],
  options: { env: Record<string, string | undefined>; timeoutMs?: number }
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    execFile(command, args, { env: options.env, timeout: options.timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => resolveRun({
        code: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" && stderr.length > 0
          ? stderr
          : error instanceof Error ? error.message : ""
      }));
  });
}
