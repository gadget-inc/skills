// Checks what the gadget-migration references say about Shopify's React Router app library by
// running the library itself, and checks assets/shopify-signatures.ts against the library's own
// validators on the same inputs. A local HTTP server stands in for Shopify. See tests/README.md.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import {
  verifyAppProxySignature,
  verifyQueryHmac,
  verifySessionToken,
  verifyWebhook,
} from "../../../skills/gadget/gadget-migration/assets/shopify-signatures.ts";

const API_KEY = "client-id-123";
const SECRET = "hush";
const SHOP = "shop-name.myshopify.com";
const sign = (message: string, encoding: "hex" | "base64" | "base64url" = "hex") => createHmac("sha256", SECRET).update(message).digest(encoding);

// Every request the library sends to a *.myshopify.com host lands on this server instead.
interface Seen {
  path: string;
  body: any;
}
let seen: Seen[] = [];
let respond: (request: Seen) => { status: number; body: unknown } = () => ({ status: 500, body: {} });
const server = http.createServer((request, response) => {
  let raw = "";
  request.on("data", (chunk) => (raw += chunk));
  request.on("end", () => {
    const entry = { path: request.url ?? "", body: raw ? JSON.parse(raw) : null };
    seen.push(entry);
    const { status, body } = respond(entry);
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
});

let shopify: any;
let api: any;
let Session: any;
let storage: any;
// builds another app with the template's settings plus the given ones, and its own session storage
let makeApp: (extra: object) => { app: any; storage: any };

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const realFetch = globalThis.fetch;
  // the library captures fetch when it loads, so redirect before importing it
  globalThis.fetch = ((input: any, init: any) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (!url.hostname.endsWith(".myshopify.com")) throw new Error(`unexpected request to ${url.hostname}`);
    return realFetch(`http://127.0.0.1:${port}${url.pathname}`, init);
  }) as typeof fetch;

  await import("@shopify/shopify-app-react-router/adapters/node");
  const { shopifyApp, AppDistribution } = await import("@shopify/shopify-app-react-router/server");
  const { MemorySessionStorage } = await import("@shopify/shopify-app-session-storage-memory");
  const shopifyApiModule = await import("@shopify/shopify-api");
  Session = shopifyApiModule.Session;
  storage = new MemorySessionStorage();
  const config = {
    apiKey: API_KEY,
    apiSecretKey: SECRET,
    appUrl: "https://app.example.com",
    scopes: ["read_orders"],
    apiVersion: shopifyApiModule.ApiVersion.October26,
  };
  // the same settings as the template's shopify.server.ts
  shopify = shopifyApp({
    ...config,
    sessionStorage: storage,
    distribution: AppDistribution.AppStore,
    future: { expiringOfflineAccessTokens: true },
  });
  api = shopifyApiModule.shopifyApi({ ...config, hostName: "app.example.com", isEmbeddedApp: true });
  makeApp = (extra) => {
    const ownStorage = new MemorySessionStorage();
    const app = shopifyApp({ ...config, sessionStorage: ownStorage, distribution: AppDistribution.AppStore, future: { expiringOfflineAccessTokens: true }, ...extra });
    return { app, storage: ownStorage };
  };
});

beforeEach(() => {
  seen = [];
  respond = () => ({ status: 500, body: {} });
});

after(() => server.close());

// A thrown Response is how the library answers a request it refuses.
const statusOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "resolved";
  } catch (thrown) {
    return thrown instanceof Response ? thrown.status : thrown;
  }
};

// The row scripts/move-shopify-tokens.ts writes, read back the way the template's Prisma session storage reads it.
const storeMovedSession = async (row: { accessToken: string; expires: Date | null; refreshToken: string | null; refreshTokenExpires: Date | null }, into: any = storage) => {
  const properties: Record<string, unknown> = { id: `offline_${SHOP}`, shop: SHOP, state: "", isOnline: false, scope: "read_orders", accessToken: row.accessToken };
  if (row.expires) properties.expires = row.expires.getTime();
  if (row.refreshToken) properties.refreshToken = row.refreshToken;
  if (row.refreshTokenExpires) properties.refreshTokenExpires = row.refreshTokenExpires.getTime();
  await into.storeSession(Session.fromPropertyArray(Object.entries(properties), true));
};
const minutes = (count: number) => new Date(Date.now() + count * 60_000);
const tokenResponse = { access_token: "shpat_new", scope: "read_orders", expires_in: 3600, refresh_token: "shprt_new", refresh_token_expires_in: 7776000 };
const RETIRED = { status: 401, body: { error: "invalid_request", error_description: "This request requires an active refresh_token" } };

const webhookRequest = (body: string, headers: Record<string, string> = {}) =>
  new Request("https://app.example.com/webhooks/orders/updated", {
    method: "POST",
    body,
    headers: {
      "X-Shopify-Hmac-Sha256": sign(body, "base64"),
      "X-Shopify-Topic": "orders/updated",
      "X-Shopify-Shop-Domain": SHOP,
      "X-Shopify-API-Version": "2026-10",
      "X-Shopify-Webhook-Id": "b54557e4-bdd9-4b37-8a5f-bf7d70bcd043",
      "X-Shopify-Event-Id": "98880550-7158-44d4-b7cd-2c97c8a091b5",
      "X-Shopify-Triggered-At": "2026-11-08T10:00:05.123456789Z",
      ...headers,
    },
  });

describe("authenticate.webhook", () => {
  const body = '{"id":5123456789,"updated_at":"2026-11-08T10:00:05-05:00"}';

  it("returns the webhook id, event id, topic, shop, and payload, and no session for a store it has no token for", async () => {
    await storage.deleteSession(`offline_${SHOP}`);
    const context = await shopify.authenticate.webhook(webhookRequest(body));
    assert.equal(context.webhookId, "b54557e4-bdd9-4b37-8a5f-bf7d70bcd043");
    assert.equal(context.eventId, "98880550-7158-44d4-b7cd-2c97c8a091b5");
    assert.equal(context.triggeredAt, "2026-11-08T10:00:05.123456789Z");
    assert.equal(context.topic, "ORDERS_UPDATED");
    assert.equal(context.shop, SHOP);
    assert.deepEqual(context.payload, JSON.parse(body));
    assert.equal(context.session, undefined);
    assert.equal(seen.length, 0);
  });

  it("answers 401 to a bad HMAC, 400 to a missing webhook id, and 405 to a GET, where the skill's verifier agrees on the HMAC", async () => {
    const forged = webhookRequest(body, { "X-Shopify-Hmac-Sha256": sign(`${body} `, "base64") });
    assert.equal(await verifyWebhook(new TextEncoder().encode(body), forged.headers.get("X-Shopify-Hmac-Sha256"), SECRET), false);
    assert.equal(await statusOf(shopify.authenticate.webhook(forged)), 401);
    assert.equal(await verifyWebhook(new TextEncoder().encode(body), webhookRequest(body).headers.get("X-Shopify-Hmac-Sha256"), SECRET), true);

    const noId = webhookRequest(body);
    noId.headers.delete("X-Shopify-Webhook-Id");
    assert.equal(await statusOf(shopify.authenticate.webhook(noId)), 400);
    assert.equal(await statusOf(shopify.authenticate.webhook(new Request("https://app.example.com/webhooks"))), 405);
  });

  it("refreshes a token that is about to expire inside the webhook request, and answers 500 when the refresh token is retired", async () => {
    await storeMovedSession({ accessToken: "shpat_old", expires: minutes(4), refreshToken: "shprt_old", refreshTokenExpires: minutes(60 * 24 * 80) });
    respond = () => ({ status: 200, body: tokenResponse });
    const context = await shopify.authenticate.webhook(webhookRequest(body));
    assert.equal(context.session.accessToken, "shpat_new");
    assert.equal(seen.length, 1);

    await storeMovedSession({ accessToken: "shpat_old", expires: minutes(4), refreshToken: "shprt_retired", refreshTokenExpires: minutes(60 * 24 * 80) });
    respond = () => RETIRED;
    // the delivery fails although its HMAC is valid, so Shopify retries it and then gives up
    assert.equal(await statusOf(shopify.authenticate.webhook(webhookRequest(body))), 500);
  });
});

describe("offline sessions written by the token move script", () => {
  it("are found under the id offline_<shop>", () => {
    assert.equal(api.session.getOfflineId(SHOP), `offline_${SHOP}`);
  });

  it("are used as they are while the access token has more than 5 minutes left", async () => {
    await storeMovedSession({ accessToken: "shpat_old", expires: minutes(6), refreshToken: "shprt_old", refreshTokenExpires: minutes(60 * 24 * 80) });
    const { session } = await shopify.unauthenticated.admin(SHOP);
    assert.equal(session.accessToken, "shpat_old");
    assert.equal(seen.length, 0);
  });

  it("are refreshed with the stored refresh token in the last 5 minutes, and both new tokens are saved", async () => {
    await storeMovedSession({ accessToken: "shpat_old", expires: minutes(4), refreshToken: "shprt_old", refreshTokenExpires: minutes(60 * 24 * 80) });
    respond = () => ({ status: 200, body: tokenResponse });
    const { session } = await shopify.unauthenticated.admin(SHOP);

    assert.equal(seen[0].path, "/admin/oauth/access_token");
    assert.deepEqual(seen[0].body, { client_id: API_KEY, client_secret: SECRET, grant_type: "refresh_token", refresh_token: "shprt_old" });
    assert.equal(session.accessToken, "shpat_new");
    const stored = await storage.loadSession(`offline_${SHOP}`);
    assert.equal(stored.accessToken, "shpat_new");
    assert.equal(stored.refreshToken, "shprt_new");
    assert.ok(Math.abs(stored.expires.getTime() - minutes(60).getTime()) < 5000);
    assert.ok(Math.abs(stored.refreshTokenExpires.getTime() - minutes(60 * 24 * 90).getTime()) < 5000);
  });

  it("throw a 500 response, not a 401, when Shopify says the refresh token is retired", async () => {
    await storeMovedSession({ accessToken: "shpat_old", expires: minutes(-1), refreshToken: "shprt_retired", refreshTokenExpires: minutes(60 * 24 * 80) });
    respond = () => RETIRED;
    assert.equal(await statusOf(shopify.unauthenticated.admin(SHOP)), 500);
    // the dead session stays in storage
    assert.equal((await storage.loadSession(`offline_${SHOP}`)).refreshToken, "shprt_retired");
  });

  it("are never refreshed or upgraded when the token does not expire", async () => {
    await storeMovedSession({ accessToken: "shpat_forever", expires: null, refreshToken: null, refreshTokenExpires: null });
    const { session } = await shopify.unauthenticated.admin(SHOP);
    assert.equal(session.accessToken, "shpat_forever");
    assert.equal(seen.length, 0);
  });

  it("are returned without a refresh attempt when the token expired and no refresh token came with it", async () => {
    await storeMovedSession({ accessToken: "shpat_dead", expires: minutes(-10), refreshToken: null, refreshTokenExpires: null });
    const { session } = await shopify.unauthenticated.admin(SHOP);
    assert.equal(session.accessToken, "shpat_dead");
    assert.equal(seen.length, 0);
  });
});

// A request from the embedded admin, with a new session token each time.
const sessionToken = () => {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: `https://${SHOP}/admin`, dest: `https://${SHOP}`, aud: API_KEY, sub: "42", exp: now + 60, nbf: now, iat: now, jti: crypto.randomUUID(), sid: "abc" };
  const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${segment({ alg: "HS256", typ: "JWT" })}.${segment(payload)}`;
  return `${unsigned}.${sign(unsigned, "base64url")}`;
};
const adminRequest = () => new Request("https://app.example.com/app/orders", { headers: { Authorization: `Bearer ${sessionToken()}` } });

describe("authenticate.admin when a merchant opens the app", () => {
  it("keeps a moved non-expiring token and asks Shopify for nothing", async () => {
    await storeMovedSession({ accessToken: "shpat_forever", expires: null, refreshToken: null, refreshTokenExpires: null });
    const { session } = await shopify.authenticate.admin(adminRequest());
    assert.equal(session.accessToken, "shpat_forever");
    assert.equal(seen.length, 0);
  });

  it("runs a token exchange, not a refresh, when the stored token is in its last 5 minutes", async () => {
    await storeMovedSession({ accessToken: "shpat_old", expires: minutes(4), refreshToken: "shprt_old", refreshTokenExpires: minutes(60 * 24 * 80) });
    respond = () => ({ status: 200, body: tokenResponse });
    const { session } = await shopify.authenticate.admin(adminRequest());
    assert.equal(session.accessToken, "shpat_new");
    assert.equal(seen[0].body.grant_type, "urn:ietf:params:oauth:grant-type:token-exchange");
    assert.equal(seen[0].body.subject_token_type, "urn:ietf:params:oauth:token-type:id_token");
    assert.equal(seen[0].body.expiring, "1");
    assert.equal(seen[0].body.refresh_token, undefined);
  });
});

// Answers the two requests an afterAuth hook causes: the token exchange, and the hook's shop query.
const SHOP_ID = 111222333n;
const answerShopify = () => {
  respond = (request) =>
    request.path === "/admin/oauth/access_token" ? { status: 200, body: tokenResponse } : { status: 200, body: { data: { shop: { id: `gid://shopify/Shop/${SHOP_ID}` } } } };
};
const exchanges = () => seen.filter((request) => request.path === "/admin/oauth/access_token").length;

describe("hooks.afterAuth", () => {
  it("runs after every token exchange: on a store's first visit, and again when its stored token is in its last 5 minutes", async () => {
    const hookRuns: string[] = [];
    const { app, storage: own } = makeApp({ hooks: { afterAuth: async ({ session }: any) => void hookRuns.push(session.shop) } });
    answerShopify();

    // the first visit after the move: the store is installed, and the new app has no session for it
    await app.authenticate.admin(adminRequest());
    assert.deepEqual(hookRuns, [SHOP]);
    assert.equal(exchanges(), 1);

    // a visit while the stored token has most of its hour left exchanges nothing and runs no hook
    await app.authenticate.admin(adminRequest());
    assert.deepEqual(hookRuns, [SHOP]);
    assert.equal(exchanges(), 1);

    // a visit that finds the token in its last 5 minutes exchanges again, and the hook runs again
    await storeMovedSession({ accessToken: "shpat_old", expires: minutes(4), refreshToken: "shprt_old", refreshTokenExpires: minutes(60 * 24 * 80) }, own);
    await app.authenticate.admin(adminRequest());
    assert.deepEqual(hookRuns, [SHOP, SHOP]);
    assert.equal(exchanges(), 2);
  });

  it("runs once for each of two requests that arrive together, and fails the request with 500 when the hook throws", async () => {
    let hookRuns = 0;
    const { app, storage: own } = makeApp({
      hooks: {
        afterAuth: async () => {
          if (++hookRuns === 3) throw new Error("install code failed");
        },
      },
    });
    answerShopify();
    await Promise.all([app.authenticate.admin(adminRequest()), app.authenticate.admin(adminRequest())]);
    assert.equal(exchanges(), 2);
    assert.equal(hookRuns, 2);

    await own.deleteSession(`offline_${SHOP}`);
    assert.equal(await statusOf(app.authenticate.admin(adminRequest())), 500);
  });
});

const DATABASE_URL = process.env.DATABASE_URL;

describe("claimInstall from shopify-webhooks.md inside hooks.afterAuth", { skip: !DATABASE_URL && "set DATABASE_URL to a Postgres superuser URL" }, () => {
  let pool: any;
  let app: any;
  let own: any;
  let installs: bigint[] = [];
  let reinstalls: bigint[] = [];
  let hookRuns = 0;
  let failInstall = false;
  let claimInstall: Function;

  before(async () => {
    const { default: pg } = await import("pg");
    const name = "gadget_migration_after_auth_test";
    const bootstrap = new pg.Client({ connectionString: DATABASE_URL });
    await bootstrap.connect();
    await bootstrap.query(`drop database if exists ${name}`);
    await bootstrap.query(`create database ${name}`);
    await bootstrap.end();
    const url = new URL(DATABASE_URL!);
    url.pathname = `/${name}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
    // the columns of ShopifyShop in schema-mapping.md's Prisma schema
    await pool.query("create table shopify_shop (id bigint primary key, myshopify_domain text not null, state text not null default 'installed')");

    const { blocks, importBlock } = await import("../integration/snippets.ts");
    ({ claimInstall } = await importBlock(blocks("shopify-webhooks.md", "app/shopify/afterAuth.server.ts")[0]));
    const handlers = {
      onInstall: async (shopId: bigint) => {
        installs.push(shopId);
        if (failInstall) throw new Error("install code failed");
      },
      onReinstall: async (shopId: bigint) => void reinstalls.push(shopId),
    };
    // wired the way the reference wires it in shopify.server.ts
    ({ app, storage: own } = makeApp({
      hooks: {
        afterAuth: ({ session, admin }: any) => {
          hookRuns++;
          return claimInstall(pool, admin, session.shop, handlers);
        },
      },
    }));
  });

  beforeEach(async () => {
    installs = [];
    reinstalls = [];
    hookRuns = 0;
    failInstall = false;
    await pool.query("truncate shopify_shop");
    await own.deleteSession(`offline_${SHOP}`);
    answerShopify();
  });

  after(() => pool?.end());

  const state = async () => (await pool.query("select id::text, myshopify_domain, state from shopify_shop")).rows;

  it("runs the install code once when two merchant requests exchange tokens at the same moment", async () => {
    await Promise.all([app.authenticate.admin(adminRequest()), app.authenticate.admin(adminRequest())]);
    // both requests exchanged a token and both ran the hook, and only one of them claimed the install
    assert.equal(exchanges(), 2);
    assert.equal(hookRuns, 2);
    assert.deepEqual(installs, [SHOP_ID]);
    assert.deepEqual(reinstalls, []);
    assert.deepEqual(await state(), [{ id: String(SHOP_ID), myshopify_domain: SHOP, state: "installed" }]);
  });

  it("runs the install code once across 20 hooks racing on one new store", async () => {
    const admin = { graphql: async () => Response.json({ data: { shop: { id: `gid://shopify/Shop/${SHOP_ID}` } } }) };
    const handlers = { onInstall: async (shopId: bigint) => void installs.push(shopId), onReinstall: async (shopId: bigint) => void reinstalls.push(shopId) };
    await Promise.all(Array.from({ length: 20 }, () => claimInstall(pool, admin, SHOP, handlers)));
    assert.deepEqual(installs, [SHOP_ID]);
    assert.deepEqual(reinstalls, []);
  });

  it("runs neither handler for a store imported from Gadget, on its first visit or on a later token exchange", async () => {
    await pool.query("insert into shopify_shop (id, myshopify_domain, state) values ($1, $2, 'installed')", [String(SHOP_ID), SHOP]);
    await app.authenticate.admin(adminRequest());
    await storeMovedSession({ accessToken: "shpat_old", expires: minutes(4), refreshToken: "shprt_old", refreshTokenExpires: minutes(60 * 24 * 80) }, own);
    await app.authenticate.admin(adminRequest());
    assert.equal(hookRuns, 2);
    assert.deepEqual(installs, []);
    assert.deepEqual(reinstalls, []);
  });

  it("runs the reinstall code once when a store that uninstalled comes back, even with two requests at once", async () => {
    await pool.query("insert into shopify_shop (id, myshopify_domain, state) values ($1, $2, 'uninstalled')", [String(SHOP_ID), SHOP]);
    await Promise.all([app.authenticate.admin(adminRequest()), app.authenticate.admin(adminRequest())]);
    assert.equal(hookRuns, 2);
    assert.deepEqual(installs, []);
    assert.deepEqual(reinstalls, [SHOP_ID]);
    assert.equal((await state())[0].state, "installed");
  });

  it("does not run the install code again after it threw, because the row was already claimed", async () => {
    failInstall = true;
    assert.equal(await statusOf(app.authenticate.admin(adminRequest())), 500);
    assert.deepEqual(installs, [SHOP_ID]);

    failInstall = false;
    await own.deleteSession(`offline_${SHOP}`);
    await app.authenticate.admin(adminRequest());
    assert.equal(hookRuns, 2);
    assert.deepEqual(installs, [SHOP_ID]); // still one: the next visit found the row
  });
});

describe("admin.graphql", () => {
  it("throws on a THROTTLED response instead of returning it", async () => {
    await storeMovedSession({ accessToken: "shpat_old", expires: minutes(30), refreshToken: "shprt_old", refreshTokenExpires: minutes(60 * 24 * 80) });
    const { admin } = await shopify.unauthenticated.admin(SHOP);
    respond = () => ({
      status: 200,
      body: { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }], extensions: { cost: { throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 3, restoreRate: 50 } } } },
    });
    const error: any = await admin.graphql("{ shop { name } }").then(
      () => null,
      (thrown: unknown) => thrown
    );
    assert.ok(error, "admin.graphql resolved");
    assert.equal(error.body?.errors?.graphQLErrors?.[0]?.extensions?.code, "THROTTLED");
  });

  it("is retried by the pacedGraphql block in shopify-sync.md until Shopify stops throttling", async () => {
    const { blocks, importBlock } = await import("../integration/snippets.ts");
    const { pacedGraphql } = await importBlock(blocks("shopify-sync.md", "app/shopify/paced.server.ts")[0]);
    await storeMovedSession({ accessToken: "shpat_old", expires: minutes(30), refreshToken: "shprt_old", refreshTokenExpires: minutes(60 * 24 * 80) });
    const { admin } = await shopify.unauthenticated.admin(SHOP);
    const cost = { cost: { throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 900, restoreRate: 50 } } };
    respond = () =>
      seen.length === 1
        ? { status: 200, body: { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }], extensions: cost } }
        : { status: 200, body: { data: { shop: { name: "Example" } }, extensions: cost } };
    const body = await pacedGraphql(admin, "{ shop { name } }", {});
    assert.equal(body.data.shop.name, "Example");
    assert.equal(seen.length, 2);
    // any other failure is not swallowed
    respond = () => ({ status: 200, body: { errors: [{ message: "Field 'nope' doesn't exist", extensions: { code: "undefinedField" } }] } });
    await assert.rejects(pacedGraphql(admin, "{ nope }", {}));
  });
});

describe("authenticate.public.appProxy and verifyAppProxySignature", () => {
  // Shopify's documented example, signed with the secret "hush"
  const documented =
    "extra=1&extra=2&shop=shop-name.myshopify.com&logged_in_customer_id=1&path_prefix=%2Fapps%2Fawesome_reviews&timestamp=1317327555&signature=4c68c8624d737112c91818c11017d24d334b524cb5c2b8ba08daa056f7395ddb";
  const proxyRequest = (query: string) => new Request(`https://app.example.com/proxy/extra/path?${query}`);

  it("both accept Shopify's documented example and reject it changed or 91 seconds old", async () => {
    await storage.deleteSession(`offline_${SHOP}`);
    mock.timers.enable({ apis: ["Date"], now: 1317327555 * 1000 });
    try {
      assert.equal(await verifyAppProxySignature(documented, SECRET), true);
      assert.equal(await statusOf(shopify.authenticate.public.appProxy(proxyRequest(documented))), "resolved");

      const changed = documented.replace("logged_in_customer_id=1", "logged_in_customer_id=2");
      assert.equal(await verifyAppProxySignature(changed, SECRET), false);
      assert.equal(await statusOf(shopify.authenticate.public.appProxy(proxyRequest(changed))), 400);

      mock.timers.setTime((1317327555 + 91) * 1000);
      assert.equal(await verifyAppProxySignature(documented, SECRET), false);
      assert.equal(await statusOf(shopify.authenticate.public.appProxy(proxyRequest(documented))), 400);
    } finally {
      mock.timers.reset();
    }
  });
});

describe("verifyQueryHmac and the library's validateHmac", () => {
  // the OAuth callback example from Shopify's documentation
  const callback =
    "code=0907a61c0c8d55e99db179b68161bc00&hmac=700e2dadb827fcc8609e9d5ce208b2e9cdaab9df07390d2cbca10d7c328fc4bf&shop=some-shop.myshopify.com&state=0.6784241404160823&timestamp=1337178173";
  const libraryAccepts = (query: string) => api.utils.validateHmac(new URLSearchParams(query)).catch(() => false);

  it("agree on Shopify's documented callback and on the parameters Shopify adds to an app load", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1337178173 * 1000 });
    try {
      assert.equal(await verifyQueryHmac(callback, SECRET), true);
      assert.equal(await libraryAccepts(callback), true);
      assert.equal(await verifyQueryHmac(callback.replace("some-shop", "other-shop"), SECRET), false);
      assert.equal(await libraryAccepts(callback.replace("some-shop", "other-shop")), false);

      const pairs = ["embedded=1", "host=YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvZXhhbXBsZQ", "id_token=aaa.bbb.ccc", "locale=en-CA", "session=4f2a", "shop=example.myshopify.com", "timestamp=1337178173"];
      const appLoad = `${pairs.toReversed().join("&")}&hmac=${sign(pairs.join("&"))}`;
      assert.equal(await verifyQueryHmac(appLoad, SECRET), true);
      assert.equal(await libraryAccepts(appLoad), true);
    } finally {
      mock.timers.reset();
    }
  });

  it("differ on a value with a space, where Shopify signs the decoded text", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1337178173 * 1000 });
    try {
      const query = `q=mix+and+match&shop=example.myshopify.com&timestamp=1337178173&hmac=${sign("q=mix and match&shop=example.myshopify.com&timestamp=1337178173")}`;
      assert.equal(await verifyQueryHmac(query, SECRET), true);
      assert.equal(await libraryAccepts(query), false); // the library signs q=mix%20and%20match
    } finally {
      mock.timers.reset();
    }
  });
});

describe("verifySessionToken and the library's decodeSessionToken", () => {
  const jwt = (overrides: object, secret = SECRET) => {
    const now = Math.floor(Date.now() / 1000);
    const payload = { iss: `https://${SHOP}/admin`, dest: `https://${SHOP}`, aud: API_KEY, sub: "42", exp: now + 60, nbf: now, iat: now, jti: "j", sid: "s", ...overrides };
    const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${segment({ alg: "HS256", typ: "JWT" })}.${segment(payload)}`;
    return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
  };
  const both = async (token: string) => {
    const skill = (await verifySessionToken(token, { clientId: API_KEY, secrets: SECRET })) !== null;
    const library = await api.session.decodeSessionToken(token).then(
      () => true,
      () => false
    );
    return { skill, library };
  };

  it("agree on valid, expired, early, forged, and wrong-app tokens, with the same 10 seconds of clock skew", async () => {
    const now = Math.floor(Date.now() / 1000);
    assert.deepEqual(await both(jwt({})), { skill: true, library: true });
    assert.deepEqual(await both(jwt({ exp: now - 5 })), { skill: true, library: true });
    assert.deepEqual(await both(jwt({ exp: now - 15 })), { skill: false, library: false });
    assert.deepEqual(await both(jwt({ nbf: now + 5 })), { skill: true, library: true });
    assert.deepEqual(await both(jwt({ nbf: now + 30 })), { skill: false, library: false });
    assert.deepEqual(await both(jwt({ aud: "another-app" })), { skill: false, library: false });
    assert.deepEqual(await both(jwt({}, "other-secret")), { skill: false, library: false });
  });

  it("differ on a token whose iss and dest name different stores, which only the skill rejects", async () => {
    assert.deepEqual(await both(jwt({ dest: "https://other.myshopify.com" })), { skill: false, library: true });
  });
});
