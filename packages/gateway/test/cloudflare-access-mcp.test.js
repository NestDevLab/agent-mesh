import assert from "node:assert/strict";
import test from "node:test";

import "./ts-extension-resolver.mjs";

const {
  cloudflareIdentityFromClaims,
  requireCloudflareAccess,
  resolveCloudflareAccessPrincipal
} = await import("../src/mcp/cloudflare-access.ts");

const binding = {
  kind: "user",
  selector: "joseph@example.test",
  allowedTools: ["mesh_list_agents", "mesh_send", "mesh_delivery_status"],
  allowedAgentIds: ["agent.ingress"],
  allowedWorkspaceIds: ["workspace.example-business"],
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
