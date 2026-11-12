// Runs the token code blocks in references/shopify-tokens.md with fetch replaced, and checks each
// request against the parameters Shopify documents. Nothing here talks to Shopify.
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, before, describe, it, mock } from "node:test";
import { blocks, importBlock } from "./integration/snippets.ts";

const SHOP = "example.myshopify.com";
const ENDPOINT = `https://${SHOP}/admin/oauth/access_token`;
const tokenResponse = { access_token: "shpat_new", scope: "read_orders", expires_in: 3600, refresh_token: "shprt_new", refresh_token_expires_in: 7776000 };

let calls: { url: string; init: RequestInit; form: Record<string, string> }[] = [];
const answer = (status: number, body: unknown) => {
  calls = [];
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init, form: Object.fromEntries(init.body as URLSearchParams) });
    return new Response(JSON.stringify(body), { status });
  });
};

afterEach(() => mock.restoreAll());

describe("app/shopify/tokens.server.ts", () => {
  let tokens: any;
  before(async () => {
    process.env.SHOPIFY_API_KEY = "client-id-123";
    process.env.SHOPIFY_API_SECRET = "hush";
    tokens = await importBlock(blocks("shopify-tokens.md", "app/shopify/tokens.server.ts")[0]);
  });

  it("refreshes with the four parameters Shopify documents and returns both new tokens with their expiry times", async () => {
    answer(200, tokenResponse);
    const before = Date.now();
    const result = await tokens.refreshOfflineToken(SHOP, "shprt_old");

    assert.equal(calls[0].url, ENDPOINT);
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(calls[0].form, { client_id: "client-id-123", client_secret: "hush", grant_type: "refresh_token", refresh_token: "shprt_old" });
    assert.equal(result.accessToken, "shpat_new");
    assert.equal(result.refreshToken, "shprt_new");
    assert.ok(result.expiresAt.getTime() - before >= 3600_000 && result.expiresAt.getTime() - before < 3605_000);
    assert.ok(result.refreshTokenExpiresAt.getTime() - before >= 7776000_000);
  });

  it("treats 401 as final and other failures as ordinary errors", async () => {
    answer(401, { error: "invalid_request", error_description: "This request requires an active refresh_token" });
    await assert.rejects(tokens.refreshOfflineToken(SHOP, "shprt_retired"), tokens.ReauthorizationRequired);
    answer(429, {});
    await assert.rejects(tokens.refreshOfflineToken(SHOP, "shprt_old"), (error: Error) => !(error instanceof tokens.ReauthorizationRequired) && /429/.test(error.message));
  });

  it("exchanges a non-expiring token with the parameters of Shopify's migration request", async () => {
    answer(200, tokenResponse);
    const result = await tokens.exchangeNonExpiringToken(SHOP, "shpat_forever");
    assert.deepEqual(calls[0].form, {
      client_id: "client-id-123",
      client_secret: "hush",
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: "shpat_forever",
      subject_token_type: "urn:shopify:params:oauth:token-type:offline-access-token",
      requested_token_type: "urn:shopify:params:oauth:token-type:offline-access-token",
      expiring: "1",
    });
    assert.equal(result.refreshToken, "shprt_new");
  });

  it("fails instead of saving a token that came back without a refresh token", async () => {
    answer(200, { access_token: "shpat_forever", scope: "read_orders" });
    await assert.rejects(tokens.exchangeNonExpiringToken(SHOP, "shpat_forever"), /no refresh token/);
  });
});

describe("app/shopify/appOnlyToken.server.ts", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let appOnly: any;
  before(async () => {
    process.env.SHOPIFY_API_KEY = "client-id-123";
    process.env.SHOPIFY_KEY_ID = "app-only-1";
    process.env.SHOPIFY_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    appOnly = await importBlock(blocks("shopify-tokens.md", "app/shopify/appOnlyToken.server.ts")[0]);
  });
  const decode = (segment: string) => JSON.parse(Buffer.from(segment, "base64url").toString());

  it("sends an assertion the registered public key verifies, with the claims Shopify checks", async () => {
    answer(200, { access_token: "shpat_app", scope: "read_orders", expires_in: 3599 });
    const now = Math.floor(Date.now() / 1000);
    const result = await appOnly.appOnlyToken(SHOP);

    const { form } = calls[0];
    assert.equal(calls[0].url, ENDPOINT);
    assert.deepEqual(Object.keys(form).sort(), ["client_assertion", "client_assertion_type", "client_id", "grant_type"]); // no client secret
    assert.equal(form.grant_type, "client_credentials");
    assert.equal(form.client_assertion_type, "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");

    const [header, claims, signature] = form.client_assertion.split(".");
    assert.ok(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, signature, "base64url"));
    assert.deepEqual(decode(header), { alg: "RS256", typ: "JWT", kid: "app-only-1" });
    const payload = decode(claims);
    assert.equal(payload.iss, "client-id-123");
    assert.equal(payload.sub, "client-id-123");
    assert.equal(payload.aud, ENDPOINT);
    assert.ok(Math.abs(payload.iat - now) <= 2);
    assert.ok(payload.exp - payload.iat > 0 && payload.exp - payload.iat <= 300);

    assert.equal(result.accessToken, "shpat_app");
    assert.ok(result.expiresAt.getTime() > Date.now() + 3590_000);
  });

  it("signs a new jti for every request", async () => {
    answer(200, { access_token: "shpat_app", scope: "read_orders", expires_in: 3599 });
    await appOnly.appOnlyToken(SHOP);
    await appOnly.appOnlyToken(SHOP);
    const [first, second] = calls.map((call) => decode(call.form.client_assertion.split(".")[1]).jti);
    assert.notEqual(first, second);
  });

  it("refuses a domain that is not a lowercase myshopify.com domain before sending anything", async () => {
    answer(200, {});
    await assert.rejects(appOnly.appOnlyToken("Example.myshopify.com"));
    await assert.rejects(appOnly.appOnlyToken("example.myshopify.com.attacker.test"));
    assert.equal(calls.length, 0);
  });
});
