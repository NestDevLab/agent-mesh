import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const {
  cloudflarePrincipalId,
  cloudflareIdentityFromClaims,
  requireCloudflareAccess,
  resolveCloudflareAccessPrincipal
} = await import("../src/mcp/cloudflare-access.ts");
const { MeshMcpFacade, FixedWindowMeshMcpRateLimiter } = await import(
  "../src/mcp/mesh-mcp.ts"
);
const { GatewayService } = await import("../src/core/gateway-service.ts");
const { AgentRegistry } = await import("../src/core/agent-registry.ts");
const { ContextRegistry } = await import("../src/core/context-registry.ts");

const binding = {
  kind: "user",
  selector: "joseph@example.test",
  allowedTools: ["mesh_list_agents", "mesh_send", "mesh_delivery_status"],
  allowedAgentIds: ["agent.ingress"],
  allowedWorkspaceIds: ["workspace.itermodus"],
  allowedDomainIds: ["domain.agent-mesh"]
};

test("maps a verified Access user to an opaque least-privilege principal", () => {
  const identity = cloudflareIdentityFromClaims({
    sub: "access-user-subject",
    email: "Joseph@Example.Test",
    exp: 1_800_000_000
  });
  const principal = resolveCloudflareAccessPrincipal(
    {
      token: "x",
      clientId: identity.subject,
      scopes: [],
      extra: { cloudflareAccessIdentity: identity }
    },
    [binding]
  );

  assert.equal(principal.kind, "user");
  assert.match(principal.id, /^[a-f0-9]{24}$/);
  assert.equal(principal.requesterId, `agent.mcp.user.${principal.id}`);
  assert.deepEqual(principal.allowedAgentIds, ["agent.ingress"]);
  assert.doesNotMatch(principal.requesterId, /joseph|example/i);
  assert.equal(principal.id, cloudflarePrincipalId("user", binding.selector));
});

test("keeps the registered requester stable when Access rotates its subject", () => {
  const resolve = (subject) => {
    const identity = cloudflareIdentityFromClaims({
      sub: subject,
      email: "joseph@example.test"
    });
    return resolveCloudflareAccessPrincipal(
      {
        token: "x",
        clientId: identity.subject,
        scopes: [],
        extra: { cloudflareAccessIdentity: identity }
      },
      [binding]
    );
  };

  assert.equal(resolve("first-subject").requesterId, resolve("rotated-subject").requesterId);
});

test("rejects an Access identity without an explicit binding", () => {
  const identity = cloudflareIdentityFromClaims({
    sub: "unbound-user",
    email: "other@example.test"
  });
  assert.throws(
    () =>
      resolveCloudflareAccessPrincipal(
        {
          token: "x",
          clientId: identity.subject,
          scopes: [],
          extra: { cloudflareAccessIdentity: identity }
        },
        [binding]
      ),
    /not bound/
  );
});

test("requires a service identity selector", () => {
  assert.throws(
    () => cloudflareIdentityFromClaims({ sub: "service-subject" }),
    /common_name/
  );
});

test("Cloudflare wrapper never forwards an unauthenticated request", async () => {
  let forwarded = 0;
  const handler = {
    async fetch() {
      forwarded += 1;
      return new Response("forwarded");
    },
    async close() {},
    async notify() {},
    bus: {}
  };
  const secured = requireCloudflareAccess(handler, {
    async authenticate() {
      throw new Error("invalid assertion");
    }
  });

  const response = await secured.fetch(new Request("https://mcp.example.test/mcp"));
  assert.equal(response.status, 401);
  assert.equal(forwarded, 0);
});

test("registered Access requester can submit through the real gateway", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agent-mesh-mcp-access-"));
  try {
    const identity = cloudflareIdentityFromClaims({
      sub: "runtime-subject",
      email: binding.selector
    });
    const principal = resolveCloudflareAccessPrincipal(
      {
        token: "x",
        clientId: identity.subject,
        scopes: [],
        extra: { cloudflareAccessIdentity: identity }
      },
      [binding]
    );
    const gateway = new GatewayService({
      stateDir,
      contextRegistry: new ContextRegistry([
        {
          id: "workspace.itermodus",
          type: "workspace",
          name: "Itermodus",
          parent_id: null,
          policy_profile: "private",
          status: "active"
        },
        {
          id: "domain.agent-mesh",
          type: "project",
          name: "Agent Mesh",
          parent_id: "workspace.itermodus",
          policy_profile: "private",
          status: "active"
        }
      ]),
      agentRegistry: new AgentRegistry([
        {
          id: principal.requesterId,
          name: "Cloudflare Access MCP requester",
          role: "mcp_ingress",
          status: "online",
          phase_1_active: true,
          capabilities: ["submit_request"],
          enabled_contexts: ["workspace.itermodus", "domain.agent-mesh"]
        },
        {
          id: "agent.ingress",
          name: "Safe ingress canary",
          role: "mcp_canary",
          status: "simulated",
          phase_1_active: true,
          capabilities: ["acknowledge_request"],
          enabled_contexts: ["workspace.itermodus", "domain.agent-mesh"]
        }
      ])
    });
    const facade = new MeshMcpFacade({
      gateway,
      principal,
      agents: [{ id: "agent.ingress", name: "Safe ingress canary", provider: "other" }],
      rateLimiter: new FixedWindowMeshMcpRateLimiter()
    });

    const submitted = await facade.dispatch({
      targetAgentId: "agent.ingress",
      workspaceId: "workspace.itermodus",
      domainId: "domain.agent-mesh",
      conversationId: "cloudflare-canary",
      message: "Verify the protected MCP ingress."
    });
    assert.match(submitted.messageId, /^mcp_/);
    assert.ok(submitted.deliveries.length > 0);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
