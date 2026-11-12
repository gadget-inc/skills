// Run with: node --test "tests/**/*.test.ts"
// Signs tokens with node:crypto, independently of the Web Crypto code under test, in the shape
// BigCommerce documents for signed_payload_jwt.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { verifyBigCommerceSignedPayload } from "../../skills/gadget/gadget-migration/assets/bigcommerce-signed-payload.ts";

const CLIENT_ID = "U8RphZeDjQc4kLVSzNjePo0CMjq7yOg";
const CLIENT_SECRET = "test-client-secret";
const NOW = 1_659_031_700_000;

const claims = {
  aud: CLIENT_ID,
  iss: "bc",
  iat: 1659031626,
  nbf: 1659031621,
  exp: 1659118026,
  jti: "c5f0bcf5-a504-4ae6-8dcc-0e40eaa5a070",
  sub: "stores/z4zn3wo",
  user: { id: 9876543, email: "authorized_user@example.com", locale: "en-US" },
  owner: { id: 7654321, email: "owner@example.com" },
  url: "/",
  channel_id: null,
};

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function sign(payload: unknown, secret = CLIENT_SECRET, header: unknown = { alg: "HS256", typ: "JWT" }): string {
  const body = `${encode(header)}.${encode(payload)}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

const verify = (token: string | null, now = NOW) => verifyBigCommerceSignedPayload(token, CLIENT_ID, CLIENT_SECRET, { now });

describe("verifyBigCommerceSignedPayload", () => {
  it("returns the claims and the store hash for a genuine token", async () => {
    const result = await verify(sign(claims));
    assert.equal(result?.storeHash, "z4zn3wo");
    assert.equal(result?.user.email, "authorized_user@example.com");
    assert.equal(result?.owner.id, 7654321);
  });

  it("rejects a token signed with another secret", async () => {
    assert.equal(await verify(sign(claims, "some-other-secret")), null);
  });

  it("rejects a token whose store was swapped after signing", async () => {
    const [header, , signature] = sign(claims).split(".");
    const forged = `${header}.${encode({ ...claims, sub: "stores/attacker" })}.${signature}`;
    assert.equal(await verify(forged), null);
  });

  it("rejects an unsigned token that claims alg none", async () => {
    const unsigned = `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.`;
    assert.equal(await verify(unsigned), null);
  });

  it("rejects a token made for another app, even when it shares the secret", async () => {
    assert.equal(await verify(sign({ ...claims, aud: "another-client-id" })), null);
  });

  it("rejects an expired token and one that is not valid yet", async () => {
    assert.equal(await verify(sign(claims), (claims.exp + 60) * 1000), null);
    assert.equal(await verify(sign(claims), (claims.nbf - 60) * 1000), null);
    // inside the 5 second tolerance on both ends
    assert.ok(await verify(sign(claims), (claims.exp + 3) * 1000));
    assert.ok(await verify(sign(claims), (claims.nbf - 3) * 1000));
  });

  it("rejects a token with no expiry, a wrong issuer, or a malformed subject", async () => {
    const { exp, ...withoutExpiry } = claims;
    assert.equal(await verify(sign(withoutExpiry)), null);
    assert.equal(await verify(sign({ ...claims, iss: "someone-else" })), null);
    assert.equal(await verify(sign({ ...claims, sub: "stores/../admin" })), null);
  });

  it("returns null instead of throwing on garbage", async () => {
    for (const token of [null, "", "abc", "a.b.c", "a.b.c.d", `${encode({ alg: "HS256" })}.not-json.sig`]) {
      assert.equal(await verify(token), null);
    }
    assert.equal(await verifyBigCommerceSignedPayload(sign(claims, ""), CLIENT_ID, ""), null);
  });
});
