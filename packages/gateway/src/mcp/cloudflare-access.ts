import { createHash } from "crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

import type { AuthInfo, McpHttpHandler } from "@modelcontextprotocol/server";
import type { MeshMcpPrincipal, MeshMcpTool } from "./mesh-mcp.js";

export interface CloudflareAccessIdentity {
  subject: string;
  kind: "user" | "service";
  selector: string;
  expiresAt?: number;
}

export interface CloudflareAccessBinding {
  kind: CloudflareAccessIdentity["kind"];
  /** Lower-case email for users; Access common_name or subject for services. */
  selector: string;
  allowedTools: readonly MeshMcpTool[];
  allowedAgentIds: readonly string[];
  allowedWorkspaceIds: readonly string[];
  allowedDomainIds: readonly string[];
}

export interface CloudflareAccessAuthenticatorOptions {
  teamDomain: string;
  audience: string;
}

export interface CloudflareAccessRequestAuthenticator {
  authenticate(request: Request): Promise<{
    authInfo: AuthInfo;
    identity: CloudflareAccessIdentity;
  }>;
}

/**
 * Validates the Access assertion at the origin. Cloudflare reaching the
 * listener is not sufficient: signature, issuer, audience, and expiry are all
 * checked against the rotating remote JWK set.
 */
export class CloudflareAccessAuthenticator {
  private readonly teamDomain: string;
  private readonly audience: string;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(options: CloudflareAccessAuthenticatorOptions) {
    this.teamDomain = options.teamDomain.replace(/\/+$/, "");
    this.audience = options.audience;
    if (!this.teamDomain.startsWith("https://") || this.audience.length === 0) {
      throw new Error("Cloudflare Access team domain and audience are required.");
    }
    this.jwks = createRemoteJWKSet(
      new URL(`${this.teamDomain}/cdn-cgi/access/certs`)
    );
  }

  async authenticate(request: Request): Promise<{
    authInfo: AuthInfo;
    identity: CloudflareAccessIdentity;
  }> {
    const token = request.headers.get("cf-access-jwt-assertion");
    if (token === null || token.length === 0) {
      throw new Error("Missing Cloudflare Access assertion.");
    }

    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.teamDomain,
      audience: this.audience
    });
    const identity = cloudflareIdentityFromClaims(payload);
    return {
      authInfo: {
        token,
        clientId: identity.subject,
        scopes: [],
        ...(identity.expiresAt === undefined ? {} : { expiresAt: identity.expiresAt }),
        extra: { cloudflareAccessIdentity: identity }
      },
      identity
    };
  }
}

/** Wraps an MCP handler so no request reaches it without origin-side JWT validation. */
export function requireCloudflareAccess(
  handler: McpHttpHandler,
  authenticator: CloudflareAccessRequestAuthenticator
): McpHttpHandler {
  const fetch = handler.fetch;
  handler.fetch = async (request) => {
    try {
      const { authInfo } = await authenticator.authenticate(request);
      return fetch(request, { authInfo });
    } catch {
      return new Response(JSON.stringify({ error: "Cloudflare Access authentication required." }), {
        status: 401,
        headers: { "content-type": "application/json" }
      });
    }
  };
  return handler;
}

export function cloudflareIdentityFromClaims(payload: JWTPayload): CloudflareAccessIdentity {
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("Cloudflare Access assertion has no subject.");
  }
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  const commonName =
    typeof payload.common_name === "string" ? payload.common_name.trim() : "";
  if (email.length > 0) {
    return {
      subject: payload.sub,
      kind: "user",
      selector: email,
      ...(payload.exp === undefined ? {} : { expiresAt: payload.exp })
    };
  }
  if (commonName.length === 0) {
    throw new Error("Cloudflare Access service assertion has no common_name.");
  }
  return {
    subject: payload.sub,
    kind: "service",
    selector: commonName,
    ...(payload.exp === undefined ? {} : { expiresAt: payload.exp })
  };
}

export function resolveCloudflareAccessPrincipal(
  authInfo: AuthInfo,
  bindings: readonly CloudflareAccessBinding[]
): MeshMcpPrincipal {
  const identity = authInfo.extra?.cloudflareAccessIdentity;
  if (!isCloudflareAccessIdentity(identity)) {
    throw new Error("Verified Cloudflare Access identity is missing.");
  }
  const binding = bindings.find(
    (candidate) =>
      candidate.kind === identity.kind &&
      normalizedSelector(candidate.kind, candidate.selector) ===
        normalizedSelector(identity.kind, identity.selector)
  );
  if (binding === undefined) {
    throw new Error("Cloudflare Access identity is not bound to an MCP principal.");
  }
  const principalId = cloudflarePrincipalId(identity.kind, identity.selector);
  return {
    id: principalId,
    kind: identity.kind,
    requesterId: `agent.mcp.${identity.kind}.${principalId}`,
    allowedTools: [...binding.allowedTools],
    allowedAgentIds: [...binding.allowedAgentIds],
    allowedWorkspaceIds: [...binding.allowedWorkspaceIds],
    allowedDomainIds: [...binding.allowedDomainIds]
  };
}

/**
 * Returns the stable opaque identifier a deployment must register as the MCP
 * source agent. The selector is signed by Access and matched to an explicit
 * binding before this value is used.
 */
export function cloudflarePrincipalId(
  kind: CloudflareAccessIdentity["kind"],
  selector: string
): string {
  return createHash("sha256")
    .update(`${kind}:${normalizedSelector(kind, selector)}`)
    .digest("hex")
    .slice(0, 24);
}

function isCloudflareAccessIdentity(value: unknown): value is CloudflareAccessIdentity {
  if (typeof value !== "object" || value === null) return false;
  const identity = value as Partial<CloudflareAccessIdentity>;
  return (
    typeof identity.subject === "string" &&
    identity.subject.length > 0 &&
    (identity.kind === "user" || identity.kind === "service") &&
    typeof identity.selector === "string" &&
    identity.selector.length > 0
  );
}

function normalizedSelector(kind: CloudflareAccessIdentity["kind"], value: string): string {
  const normalized = value.trim();
  return kind === "user" ? normalized.toLowerCase() : normalized;
}
