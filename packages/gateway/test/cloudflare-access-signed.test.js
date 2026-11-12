import assert from "node:assert/strict";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import "./ts-extension-resolver.mjs";

const { CloudflareAccessAuthenticator, cloudflareIdentityFromClaims, requireCloudflareAccess } =
  await import("../src/mcp/cloudflare-access.ts");

test("rejects every present non-string subject before service fallback", () => {
  for (const sub of [null, 0, false, {}, [], undefined]) {
    for (const email of [undefined, "user@example.test"]) {
      assert.throws(
        () => cloudflareIdentityFromClaims({
          sub,
          common_name: "synthetic-service",
          ...(email === undefined ? {} : { email })
        }),
        /subject/,
        `subject type ${sub === null ? "null" : typeof sub}, email ${email !== undefined}`
      );
    }
  }
});

test("signed assertions reach service fallback only after origin JWT verification", async (t) => {
  const issuer = "https://access.example.test";
  const audience = "synthetic-audience";
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const other = await generateKeyPair("ES256");
  const jwk = { ...await exportJWK(publicKey), kid: "test-key", alg: "ES256" };
  let jwksReads = 0;
  // Only the JWKS transport is synthetic: signing and jwtVerify remain real.
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(String(url), `${issuer}/cdn-cgi/access/certs`);
    jwksReads += 1;
    return Response.json({ keys: [jwk] });
  });
  const authenticator = new CloudflareAccessAuthenticator({ teamDomain: issuer, audience });
  const accepted = [];
  const errors = [];
  const handler = requireCloudflareAccess({
    async fetch(_request, { authInfo }) {
      accepted.push(authInfo.extra.cloudflareAccessIdentity);
      return new Response(null, { status: 204 });
    }
  }, authenticator, (error) => errors.push(error));
  const now = Math.floor(Date.now() / 1000);
  const sign = (claims = {}, key = privateKey) => new SignJWT({
    iss: issuer, aud: audience, exp: now + 300,
    sub: "", common_name: "synthetic-service", ...claims
  }).setProtectedHeader({ alg: "ES256", kid: "test-key" }).sign(key);
  const request = async (token) => handler.fetch(new Request("https://gateway.example.test/agent-mesh", {
    headers: { "cf-access-jwt-assertion": token }
  }));

  for (const sub of ["", undefined]) {
    const response = await request(await sign({ sub }));
    assert.equal(response.status, 204);
    assert.deepEqual(accepted.at(-1), {
      kind: "service", subject: "synthetic-service", selector: "synthetic-service", expiresAt: now + 300
    });
  }
  assert.equal(jwksReads, 1);
  assert.equal(errors.length, 0);

  for (const [claims, key, code] of [
    [{ iss: "https://wrong.example.test" }, privateKey, "ERR_JWT_CLAIM_VALIDATION_FAILED"],
    [{ aud: "wrong-audience" }, privateKey, "ERR_JWT_CLAIM_VALIDATION_FAILED"],
    [{ exp: now - 60 }, privateKey, "ERR_JWT_EXPIRED"],
    [{}, other.privateKey, "ERR_JWS_SIGNATURE_VERIFICATION_FAILED"]
  ]) {
    const response = await request(await sign(claims, key));
    assert.equal(response.status, 401);
    assert.equal(errors.at(-1).code, code);
    assert.equal(accepted.length, 2, "invalid JWT must never reach the handler");
  }
  for (const sub of [null, 0, false, {}, []]) {
    assert.equal((await request(await sign({ sub }))).status, 401);
    assert.equal(accepted.length, 2, "signed malformed subject must fail closed");
  }
  assert.equal((await request(await sign({ email: "user@example.test" }))).status, 401);
  assert.equal(accepted.length, 2, "verified user still requires a nonempty subject");
});
