// Run with: node --test "tests/**/*.test.ts"   (Node 22.18+ or 23.6+ strip the TypeScript types without flags)
import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  verifyAppProxySignature,
  verifyQueryHmac,
  verifySessionToken,
  verifyWebhook,
} from "../../skills/gadget/gadget-migration/assets/shopify-signatures.ts";

const SECRET = "hush";
const encode = (text: string) => new TextEncoder().encode(text);
const sign = (message: string, secret = SECRET, encoding: "hex" | "base64" | "base64url" = "hex") =>
  createHmac("sha256", secret).update(message).digest(encoding);

describe("verifyWebhook", () => {
  // Shopify sends JSON with no spaces; a body parser that re-serializes it changes the bytes
  const body = '{"id":820982911946154508,"email":"jon@example.com","total_price":"12.50"}';
  const header = sign(body, SECRET, "base64");

  it("accepts a delivery signed with the client secret", async () => {
    assert.equal(await verifyWebhook(encode(body), header, SECRET), true);
  });

  it("accepts a Buffer or an ArrayBuffer body", async () => {
    assert.equal(await verifyWebhook(Buffer.from(body), header, SECRET), true);
    assert.equal(await verifyWebhook(encode(body).buffer as ArrayBuffer, header, SECRET), true);
  });

  it("rejects a body that was parsed and re-serialized", async () => {
    // JSON.parse loses precision on the 18-digit id, so the bytes no longer match the signature
    const reserialized = JSON.stringify(JSON.parse(body));
    assert.notEqual(reserialized, body);
    assert.equal(await verifyWebhook(encode(reserialized), header, SECRET), false);
  });

  it("rejects a changed body, a wrong secret, and a missing or malformed header", async () => {
    assert.equal(await verifyWebhook(encode(body.replace("12.50", "0.01")), header, SECRET), false);
    assert.equal(await verifyWebhook(encode(body), header, "other-secret"), false);
    assert.equal(await verifyWebhook(encode(body), null, SECRET), false);
    assert.equal(await verifyWebhook(encode(body), "", SECRET), false);
    assert.equal(await verifyWebhook(encode(body), "not base64!", SECRET), false);
    assert.equal(await verifyWebhook(encode(body), sign(body, SECRET, "hex"), SECRET), false);
  });

  it("accepts either secret during a rotation", async () => {
    const signedWithOld = sign(body, "old-secret", "base64");
    assert.equal(await verifyWebhook(encode(body), signedWithOld, ["new-secret", "old-secret"]), true);
    assert.equal(await verifyWebhook(encode(body), signedWithOld, ["new-secret"]), false);
  });

  it("returns false instead of throwing when the secret is empty", async () => {
    assert.equal(await verifyWebhook(encode(body), header, ""), false);
    assert.equal(await verifyWebhook(encode(body), header, ["", SECRET]), true);
  });
});

describe("verifyQueryHmac", () => {
  // the OAuth callback example from Shopify's documentation, signed with the secret "hush"
  const callback =
    "code=0907a61c0c8d55e99db179b68161bc00&hmac=700e2dadb827fcc8609e9d5ce208b2e9cdaab9df07390d2cbca10d7c328fc4bf&shop=some-shop.myshopify.com&state=0.6784241404160823&timestamp=1337178173";
  const atCallback = { nowSeconds: 1337178173 + 30 };
  const now = 1_700_000_000;
  const at = { nowSeconds: now };

  it("accepts Shopify's documented example", async () => {
    assert.equal(await verifyQueryHmac(callback, SECRET, atCallback), true);
    assert.equal(await verifyQueryHmac(new URL(`https://app.example.com/auth/callback?${callback}`).searchParams, SECRET, atCallback), true);
  });

  it("rejects a timestamp more than 90 seconds from now", async () => {
    assert.equal(await verifyQueryHmac(callback, SECRET), false); // signed in 2012
    assert.equal(await verifyQueryHmac(callback, SECRET, { nowSeconds: 1337178173 + 91 }), false);
    assert.equal(await verifyQueryHmac(callback, SECRET, { nowSeconds: 1337178173 - 91 }), false);
  });

  it("does not depend on parameter order in the URL", async () => {
    const reordered = "timestamp=1337178173&state=0.6784241404160823&shop=some-shop.myshopify.com&hmac=700e2dadb827fcc8609e9d5ce208b2e9cdaab9df07390d2cbca10d7c328fc4bf&code=0907a61c0c8d55e99db179b68161bc00";
    assert.equal(await verifyQueryHmac(reordered, SECRET, atCallback), true);
  });

  it("rejects a changed parameter and a wrong secret", async () => {
    assert.equal(await verifyQueryHmac(callback.replace("some-shop", "other-shop"), SECRET, atCallback), false);
    assert.equal(await verifyQueryHmac(callback, "other-secret", atCallback), false);
  });

  it("signs decoded values", async () => {
    const message = `host=YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvZXhhbXBsZQ&q=mix and match&shop=example.myshopify.com&timestamp=${now}`;
    const query = `q=mix%20and%20match&host=YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvZXhhbXBsZQ&shop=example.myshopify.com&timestamp=${now}&hmac=${sign(message)}`;
    assert.equal(await verifyQueryHmac(query, SECRET, at), true);
  });

  it("signs an array once, in the form ids=[\"1\", \"2\"]", async () => {
    // an admin bulk action link for two selected records
    const hmac = sign(`ids=["1", "2"]&shop=example.myshopify.com&timestamp=${now}`);
    assert.equal(await verifyQueryHmac(`ids[]=1&ids[]=2&shop=example.myshopify.com&timestamp=${now}&hmac=${hmac}`, SECRET, at), true);
    // one parameter holding the same text is not the same request
    const asScalar = `ids=${encodeURIComponent('["1", "2"]')}&shop=example.myshopify.com&timestamp=${now}&hmac=${hmac}`;
    assert.equal(await verifyQueryHmac(asScalar, SECRET, at), false);
  });

  it("sorts whole key=value pairs, not keys", async () => {
    // as keys, "q" sorts before "q2". As pairs, "q2=x" sorts before "q=y" because "2" is below "="
    const hmac = sign(`q2=x&q=y&timestamp=${now}`);
    assert.equal(await verifyQueryHmac(`q=y&q2=x&timestamp=${now}&hmac=${hmac}`, SECRET, at), true);
  });

  it("escapes % and & in values before signing", async () => {
    const hmac = sign(`q=50%25 off %26 more&timestamp=${now}`);
    assert.equal(await verifyQueryHmac(`q=50%25+off+%26+more&timestamp=${now}&hmac=${hmac}`, SECRET, at), true);
  });

  it("leaves a legacy signature parameter out of the signed string", async () => {
    const hmac = sign(`shop=example.myshopify.com&timestamp=${now}`);
    assert.equal(await verifyQueryHmac(`shop=example.myshopify.com&timestamp=${now}&signature=abc&hmac=${hmac}`, SECRET, at), true);
  });

  it("rejects a query whose values were re-split", async () => {
    // Shopify signed one parameter, note="safe&admin=true", with the & escaped
    const signedAsOne = sign(`note=safe%26admin=true&shop=example.myshopify.com&timestamp=${now}`);
    assert.equal(await verifyQueryHmac(`note=safe%26admin%3Dtrue&shop=example.myshopify.com&timestamp=${now}&hmac=${signedAsOne}`, SECRET, at), true);
    // sent as two parameters, it would let a caller add admin=true
    assert.equal(await verifyQueryHmac(`note=safe&admin=true&shop=example.myshopify.com&timestamp=${now}&hmac=${signedAsOne}`, SECRET, at), false);
  });

  it("rejects a repeated key that is not an array", async () => {
    const hmac = sign(`a=1&shop=example.myshopify.com&timestamp=${now}`);
    assert.equal(await verifyQueryHmac(`a=1&a=1&shop=example.myshopify.com&timestamp=${now}&hmac=${hmac}`, SECRET, at), false);
  });

  it("rejects a missing hmac or timestamp", async () => {
    assert.equal(await verifyQueryHmac(`shop=example.myshopify.com&timestamp=${now}`, SECRET, at), false);
    assert.equal(await verifyQueryHmac(`shop=example.myshopify.com&hmac=${sign("shop=example.myshopify.com")}`, SECRET, at), false);
  });
});

describe("verifyAppProxySignature", () => {
  // both examples from Shopify's app proxy documentation, signed with the secret "hush"
  const loggedIn =
    "extra=1&extra=2&shop=shop-name.myshopify.com&logged_in_customer_id=1&path_prefix=%2Fapps%2Fawesome_reviews&timestamp=1317327555&signature=4c68c8624d737112c91818c11017d24d334b524cb5c2b8ba08daa056f7395ddb";
  const anonymous =
    "extra=1&extra=2&shop=shop-name.myshopify.com&logged_in_customer_id=&path_prefix=%2Fapps%2Fawesome_reviews&timestamp=1317327555&signature=e072b6d7e6622d85912a5214b860d3100dc1e73d9bc29f43796ac8c9ff8093cb";
  const at = { nowSeconds: 1317327555 };

  it("accepts Shopify's documented examples", async () => {
    assert.equal(await verifyAppProxySignature(loggedIn, SECRET, at), true);
    assert.equal(await verifyAppProxySignature(anonymous, SECRET, at), true);
  });

  it("rejects an old request", async () => {
    assert.equal(await verifyAppProxySignature(loggedIn, SECRET), false);
  });

  it("rejects a changed customer id", async () => {
    assert.equal(await verifyAppProxySignature(loggedIn.replace("logged_in_customer_id=1", "logged_in_customer_id=2"), SECRET, at), false);
    assert.equal(await verifyAppProxySignature(anonymous.replace("logged_in_customer_id=", "logged_in_customer_id=1"), SECRET, at), false);
  });

  it("rejects the same signed string split into different parameters", async () => {
    // signs the same bytes as the logged-in example, but drops shop and timestamp
    const resplit =
      "extra=1,2&logged_in_customer_id=1path_prefix%3D%2Fapps%2Fawesome_reviewsshop%3Dshop-name.myshopify.comtimestamp%3D1317327555&signature=4c68c8624d737112c91818c11017d24d334b524cb5c2b8ba08daa056f7395ddb";
    assert.equal(await verifyAppProxySignature(resplit, SECRET, at), false);
  });

  it("rejects a customer id moved in from another parameter", async () => {
    // A visitor logged in as customer 5 requests /apps/awesome_reviews?extra=1&m=xlogged_in_customer_id%3D7.
    // Shopify signs these five pairs. If the visitor ever sees that signed URL, the same string
    // re-splits into a request from customer 7.
    const signed = sign(
      "extra=1" + "logged_in_customer_id=5" + "m=xlogged_in_customer_id=7" + "path_prefix=/apps/awesome_reviews" + "shop=shop-name.myshopify.com" + "timestamp=1317327555"
    );
    const genuine = `extra=1&m=xlogged_in_customer_id%3D7&shop=shop-name.myshopify.com&logged_in_customer_id=5&path_prefix=%2Fapps%2Fawesome_reviews&timestamp=1317327555&signature=${signed}`;
    const forged = `extra=${encodeURIComponent("1logged_in_customer_id=5m=x")}&logged_in_customer_id=7&path_prefix=%2Fapps%2Fawesome_reviews&shop=shop-name.myshopify.com&timestamp=1317327555&signature=${signed}`;
    assert.equal(await verifyAppProxySignature(forged, SECRET, at), false);
    // the request Shopify really sent is refused too, because it can't be told apart from the forgery
    assert.equal(await verifyAppProxySignature(genuine, SECRET, at), false);
  });

  it("rejects a shop moved in from another parameter", async () => {
    // signed for shop-name.myshopify.com, with pz=1q and si=wshop=victim.myshopify.com added by the caller
    const signed = sign(
      "logged_in_customer_id=" + "path_prefix=/apps/x" + "pz=1q" + "shop=shop-name.myshopify.com" + "si=wshop=victim.myshopify.com" + "timestamp=1317327555"
    );
    const forged = `logged_in_customer_id=&path_prefix=%2Fapps%2Fx&pz=1&qshop=${encodeURIComponent("shop-name.myshopify.comsi=w")}&shop=victim.myshopify.com&timestamp=1317327555&signature=${signed}`;
    assert.equal(await verifyAppProxySignature(forged, SECRET, at), false);
  });

  it("accepts ordinary extra parameters, and refuses one whose name ends in shop", async () => {
    const base = "logged_in_customer_id=1" + "path_prefix=/apps/awesome_reviews" + "shop=shop-name.myshopify.com" + "timestamp=1317327555";
    const query = "shop=shop-name.myshopify.com&logged_in_customer_id=1&path_prefix=%2Fapps%2Fawesome_reviews&timestamp=1317327555";
    assert.equal(await verifyAppProxySignature(`id=42&page=2&${query}&signature=${sign("id=42" + base.replace("path_prefix", "page=2path_prefix"))}`, SECRET, at), true);
    assert.equal(await verifyAppProxySignature(`${query}&workshop=1&signature=${sign(base + "workshop=1")}`, SECRET, at), false);
  });

  it("rejects a key containing '='", async () => {
    const signature = sign("a=b=clogged_in_customer_id=shop=shop-name.myshopify.comtimestamp=1317327555");
    assert.equal(await verifyAppProxySignature(`a%3Db=c&logged_in_customer_id=&shop=shop-name.myshopify.com&timestamp=1317327555&signature=${signature}`, SECRET, at), false);
  });
});

describe("verifySessionToken", () => {
  const clientId = "client-id-123";
  const now = 1_700_000_000;
  const basePayload = {
    iss: "https://example.myshopify.com/admin",
    dest: "https://example.myshopify.com",
    aud: clientId,
    sub: "42",
    exp: now + 60,
    nbf: now,
    iat: now,
    jti: "f8912129-1af6-4cad-9ca3-76b0f7621087",
    sid: "aaea182f2732d44c23057c0fea584021",
  };
  const jwt = (payload: object, header: object = { alg: "HS256", typ: "JWT" }, secret = SECRET) => {
    const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${segment(header)}.${segment(payload)}`;
    return `${unsigned}.${sign(unsigned, secret, "base64url")}`;
  };

  it("returns the shop for a valid token", async () => {
    const result = await verifySessionToken(jwt(basePayload), { clientId, secrets: SECRET, nowSeconds: now });
    assert.equal(result?.shop, "example.myshopify.com");
    assert.equal(result?.payload.sub, "42");
  });

  it("rejects expired and not-yet-valid tokens, allowing 10 seconds of clock skew", async () => {
    const expired = jwt({ ...basePayload, exp: now - 11 });
    assert.equal(await verifySessionToken(expired, { clientId, secrets: SECRET, nowSeconds: now }), null);
    const barelyExpired = jwt({ ...basePayload, exp: now - 9 });
    assert.notEqual(await verifySessionToken(barelyExpired, { clientId, secrets: SECRET, nowSeconds: now }), null);
    const early = jwt({ ...basePayload, nbf: now + 30 });
    assert.equal(await verifySessionToken(early, { clientId, secrets: SECRET, nowSeconds: now }), null);
  });

  it("rejects a token for another app, a mismatched store, or a non-Shopify domain", async () => {
    const options = { clientId, secrets: SECRET, nowSeconds: now };
    assert.equal(await verifySessionToken(jwt({ ...basePayload, aud: "another-app" }), options), null);
    assert.equal(await verifySessionToken(jwt({ ...basePayload, dest: "https://other.myshopify.com" }), options), null);
    const attacker = { ...basePayload, iss: "https://example.myshopify.com.attacker.test/admin", dest: "https://example.myshopify.com.attacker.test" };
    assert.equal(await verifySessionToken(jwt(attacker), options), null);
  });

  it("rejects a forged signature, alg none, and malformed tokens", async () => {
    const options = { clientId, secrets: SECRET, nowSeconds: now };
    assert.equal(await verifySessionToken(jwt(basePayload, undefined, "other-secret"), options), null);
    const unsignedHeader = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const unsignedPayload = Buffer.from(JSON.stringify(basePayload)).toString("base64url");
    assert.equal(await verifySessionToken(`${unsignedHeader}.${unsignedPayload}.`, options), null);
    assert.equal(await verifySessionToken(jwt(basePayload, { alg: "HS512" }), options), null);
    assert.equal(await verifySessionToken("not-a-jwt", options), null);
  });
});
