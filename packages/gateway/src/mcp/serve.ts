import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { AgentRegistry } from "../core/agent-registry.js";
import { ContextRegistry } from "../core/context-registry.js";
import { GatewayService } from "../core/gateway-service.js";
import { validateMeshAgentRecord, type MeshAgentRecord } from "../schema/agent.js";
import { validateMeshContextRecord, type MeshContextRecord } from "../schema/context.js";
import {
  CloudflareAccessAuthenticator,
  cloudflarePrincipalId,
  requireCloudflareAccess,
  resolveCloudflareAccessBinding,
  resolveCloudflareAccessPrincipal,
  type CloudflareAccessBinding
} from "./cloudflare-access.js";
import { GogGoogleWorkspaceRunner, type GoogleWorkspaceAccount } from "./google-workspace.js";
import { createMcpHubHandler, type McpHubProfile } from "./hub-mcp.js";
import {
  createMeshMcpHandler,
  FixedWindowMeshMcpRateLimiter,
  type MeshMcpAgent
} from "./mesh-mcp.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8790;
const AGENT_MESH_PATH = "/agent-mesh";
const MAX_BODY_BYTES = 1_048_576;

interface RuntimeAgent extends MeshAgentRecord {
  provider: MeshMcpAgent["provider"];
}

interface RuntimeConfig {
  stateDir: string;
  agents: RuntimeAgent[];
  contexts: MeshContextRecord[];
  bindings: CloudflareAccessBinding[];
  googleWorkspace?: {
    accounts: {
      work: GoogleWorkspaceAccount;
      personal: GoogleWorkspaceAccount;
    };
  };
}

export interface McpRequestBodyCompatibility {
  body: ArrayBuffer;
  wrapJsonRpcResponse: boolean;
}

export async function startMeshMcpServer(env = process.env): Promise<() => Promise<void>> {
  const host = env.AGENT_MESH_MCP_HOST ?? DEFAULT_HOST;
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("AGENT_MESH_MCP_HOST must be a loopback address.");
  }
  const port = parsePort(env.AGENT_MESH_MCP_PORT);
  const teamDomain = requiredEnv(env, "AGENT_MESH_MCP_TEAM_DOMAIN");
  const audience = requiredEnv(env, "AGENT_MESH_MCP_AUDIENCE");
  const configPath = resolve(requiredEnv(env, "AGENT_MESH_MCP_CONFIG"));
  const config = await readRuntimeConfig(configPath);

  const requesterAgents: MeshAgentRecord[] = config.bindings.map((binding) => {
    const principalId = cloudflarePrincipalId(binding.kind, binding.selector);
    return {
      id: `agent.mcp.${binding.kind}.${principalId}`,
      name: `Cloudflare Access ${binding.kind} requester`,
      role: "mcp_ingress",
      status: "online",
      phase_1_active: true,
      capabilities: ["submit_request"],
      enabled_contexts: unique([
        ...binding.allowedWorkspaceIds,
        ...binding.allowedDomainIds
      ])
    };
  });
  const gateway = new GatewayService({
    stateDir: resolve(config.stateDir),
    contextRegistry: new ContextRegistry(config.contexts),
    agentRegistry: new AgentRegistry([...requesterAgents, ...config.agents])
  });
  const bindings = config.bindings;
  const handlers = new Map<string, ReturnType<typeof requireCloudflareAccess>>();
  const meshHandler = requireCloudflareAccess(
    createMeshMcpHandler({
      gateway,
      agents: config.agents.map(({ id, name, provider, capabilities }) => ({
        id,
        name,
        provider,
        capabilities
      })),
      rateLimiter: new FixedWindowMeshMcpRateLimiter(),
      resolvePrincipal: (authInfo) => resolveCloudflareAccessPrincipal(authInfo, bindings)
    }),
    new CloudflareAccessAuthenticator({ teamDomain, audience })
  );
  handlers.set(AGENT_MESH_PATH, meshHandler);

  const googleRunner = config.googleWorkspace === undefined
    ? undefined
    : new GogGoogleWorkspaceRunner(config.googleWorkspace.accounts);
  for (const profile of hubProfiles(env)) {
    if (googleRunner === undefined && profile.name !== "memory") {
      throw new Error(`Google Workspace configuration is required for /${profile.name}.`);
    }
    const hubHandler = createMcpHubHandler({
      profile: profile.name,
      gateway,
      agents: config.agents.map(({ id, name, provider, capabilities }) => ({
        id, name, provider, capabilities
      })),
      rateLimiter: new FixedWindowMeshMcpRateLimiter(),
      googleRunner: googleRunner ?? unavailableGoogleRunner,
      memoryState: parseMemoryState(env.AGENT_MESH_MCP_MEMORY_STATE),
      resolvePrincipal: (authInfo) => {
        const binding = resolveCloudflareAccessBinding(authInfo, bindings);
        return {
          mesh: resolveCloudflareAccessPrincipal(authInfo, bindings),
          allowedGoogleAccounts: binding.allowedGoogleAccounts ?? []
        };
      }
    });
    handlers.set(`/${profile.name}`, requireCloudflareAccess(
      hubHandler,
      new CloudflareAccessAuthenticator({ teamDomain, audience: profile.audience })
    ));
  }

  const server = createServer((request, response) => {
    void serveRequest(request, response, handlers, host, port);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  process.stdout.write(`MCP hub listening on http://${host}:${port} (${[...handlers.keys()].join(", ")})\n`);
  return async () => {
    await Promise.all([...handlers.values()].map((handler) => handler.close()));
    await new Promise<void>((resolveClose, reject) =>
      server.close((error) => (error === undefined ? resolveClose() : reject(error)))
    );
  };
}

async function serveRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  handlers: ReadonlyMap<string, { fetch(request: Request): Promise<Response> }>,
  host: string,
  port: number
): Promise<void> {
  try {
    const url = new URL(incoming.url ?? "/", `http://${host}:${port}`);
    const handler = handlers.get(url.pathname);
    if (handler === undefined) {
      sendJson(outgoing, 404, { error: "Not found." });
      return;
    }
    const method = incoming.method ?? "GET";
    const body =
      method === "GET" || method === "HEAD"
        ? undefined
        : adaptMcpRequestBody(
            await readBody(incoming),
            incoming.headers["mcp-protocol-version"],
            incoming.headers["mcp-method"]
          );
    const request = new Request(url, {
      method,
      headers: headersFromIncoming(incoming),
      ...(body === undefined ? {} : { body: body.body })
    });
    const handlerResponse = await handler.fetch(request);
    const response = body?.wrapJsonRpcResponse === true
      ? await wrapSingletonJsonRpcResponse(handlerResponse)
      : handlerResponse;
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    const status = error instanceof BodyTooLargeError ? 413 : 500;
    sendJson(outgoing, status, {
      error: status === 413 ? "Request body too large." : "Internal server error."
    });
  }
}

/**
 * ChatGPT currently sends one modern tools/call request in a JSON-RPC batch.
 * MCP 2026 forbids batches, so accept only that singleton compatibility shape
 * and keep multi-request batches on the SDK's normal rejection path.
 */
export function adaptMcpRequestBody(
  body: Buffer,
  protocolVersion: string | string[] | undefined,
  mcpMethod: string | string[] | undefined
): McpRequestBodyCompatibility {
  const unchanged = (): McpRequestBodyCompatibility => ({
    body: Uint8Array.from(body).buffer,
    wrapJsonRpcResponse: false
  });
  if (protocolVersion !== "2026-07-28" || mcpMethod !== "tools/call") return unchanged();

  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 1 ||
      typeof parsed[0] !== "object" ||
      parsed[0] === null ||
      Array.isArray(parsed[0]) ||
      (parsed[0] as { jsonrpc?: unknown }).jsonrpc !== "2.0" ||
      (parsed[0] as { method?: unknown }).method !== "tools/call"
    ) {
      return unchanged();
    }
    return {
      body: Uint8Array.from(Buffer.from(JSON.stringify(parsed[0]))).buffer,
      wrapJsonRpcResponse: true
    };
  } catch {
    return unchanged();
  }
}

export async function wrapSingletonJsonRpcResponse(response: Response): Promise<Response> {
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return response;
  }
  const text = await response.text();
  let body = text;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as { jsonrpc?: unknown }).jsonrpc === "2.0"
    ) {
      body = JSON.stringify([parsed]);
    }
  } catch {
    // Preserve non-JSON bodies even if an upstream mislabeled the response.
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function readRuntimeConfig(filePath: string): Promise<RuntimeConfig> {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<RuntimeConfig>;
  if (
    typeof parsed.stateDir !== "string" ||
    !Array.isArray(parsed.agents) ||
    !Array.isArray(parsed.contexts) ||
    !Array.isArray(parsed.bindings) ||
    parsed.bindings.length === 0
  ) {
    throw new Error("Invalid Agent Mesh MCP runtime config.");
  }
  const agents = parsed.agents.map((agent, index) => {
    const validated = validateMeshAgentRecord(agent);
    const provider = (agent as Partial<RuntimeAgent>).provider;
    if (!validated.ok || !["codex", "claude", "other"].includes(provider ?? "")) {
      throw new Error(`Invalid MCP runtime agent at index ${index}.`);
    }
    return { ...validated.value!, provider: provider! };
  });
  const contexts = parsed.contexts.map((context, index) => {
    const validated = validateMeshContextRecord(context);
    if (!validated.ok) throw new Error(`Invalid MCP runtime context at index ${index}.`);
    return validated.value!;
  });
  for (const [index, binding] of parsed.bindings.entries()) validateBinding(binding, index, agents);
  validateGoogleWorkspace(parsed.googleWorkspace);
  return {
    stateDir: parsed.stateDir,
    agents,
    contexts,
    bindings: parsed.bindings,
    ...(parsed.googleWorkspace === undefined ? {} : { googleWorkspace: parsed.googleWorkspace })
  };
}

function validateBinding(
  binding: CloudflareAccessBinding,
  index: number,
  agents: readonly RuntimeAgent[]
): void {
  if (
    (binding.kind !== "user" && binding.kind !== "service") ||
    typeof binding.selector !== "string" ||
    binding.selector.length === 0 ||
    !Array.isArray(binding.allowedTools) ||
    !Array.isArray(binding.allowedAgentIds) ||
    !Array.isArray(binding.allowedWorkspaceIds) ||
    !Array.isArray(binding.allowedDomainIds) ||
    (binding.allowedGoogleAccounts !== undefined &&
      (!Array.isArray(binding.allowedGoogleAccounts) ||
        binding.allowedGoogleAccounts.some((value) => value !== "work" && value !== "personal")))
  ) {
    throw new Error(`Invalid MCP runtime binding at index ${index}.`);
  }
  const exposed = new Set(agents.map((agent) => agent.id));
  if (binding.allowedAgentIds.some((agentId) => !exposed.has(agentId))) {
    throw new Error(`MCP runtime binding ${index} refers to an unknown agent.`);
  }
}

function validateGoogleWorkspace(value: RuntimeConfig["googleWorkspace"]): void {
  if (value === undefined) return;
  for (const alias of ["work", "personal"] as const) {
    const account = value.accounts?.[alias];
    if (
      account === undefined ||
      typeof account.account !== "string" ||
      account.account.length === 0 ||
      (account.client !== undefined && (typeof account.client !== "string" || account.client.length === 0))
    ) {
      throw new Error(`Invalid Google Workspace ${alias} account configuration.`);
    }
  }
}

function hubProfiles(env: NodeJS.ProcessEnv): Array<{ name: McpHubProfile; audience: string }> {
  const definitions: Array<[McpHubProfile, string]> = [
    ["workspace", "AGENT_MESH_MCP_WORKSPACE_AUDIENCE"],
    ["google-workspace", "AGENT_MESH_MCP_GOOGLE_WORKSPACE_AUDIENCE"],
    ["memory", "AGENT_MESH_MCP_MEMORY_AUDIENCE"]
  ];
  return definitions.flatMap(([name, variable]) => {
    const audience = env[variable]?.trim();
    return audience ? [{ name, audience }] : [];
  });
}

function parseMemoryState(value: string | undefined): "setup_required" | "ready" | "degraded" {
  if (value === undefined || value === "setup_required") return "setup_required";
  if (value === "ready" || value === "degraded") return value;
  throw new Error("AGENT_MESH_MCP_MEMORY_STATE is invalid.");
}

const unavailableGoogleRunner = {
  async run(): Promise<unknown> {
    throw new Error("Google Workspace is not configured.");
  },
  async readFile(): Promise<unknown> {
    throw new Error("Google Workspace is not configured.");
  }
};

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function headersFromIncoming(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("AGENT_MESH_MCP_PORT must be a valid TCP port.");
  }
  return port;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

class BodyTooLargeError extends Error {}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMeshMcpServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown startup error";
    process.stderr.write(`Agent Mesh MCP failed to start: ${message}\n`);
    process.exitCode = 1;
  });
}
