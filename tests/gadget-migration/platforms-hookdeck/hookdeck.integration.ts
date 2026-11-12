// Run with: npm test (from this folder). No Hookdeck account needed: scripts/hookdeck.ts from
// references/platforms/hookdeck.md runs against a local stand-in for Hookdeck's API, which validates each request
// body against the schemas in hookdeck-openapi-subset.json (from Hookdeck's OpenAPI document, API version 2026-09-01).
// The cleanup job needs DATABASE_URL, a Postgres superuser URL, and skips without it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import { build } from "esbuild";
import { block, typecheck, writeProject } from "../platform-blocks.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.HOOKDECK_STANDIN_PORT ?? 57560);
const ADMIN_URL = process.env.DATABASE_URL;
const TEST_URL = ADMIN_URL ? Object.assign(new URL(ADMIN_URL), { pathname: "/hookdeck_cleanup_test" }).toString() : "";
const services = { "app/db.server.ts": 'import { PrismaClient } from "@prisma/client";\nconst prisma = new PrismaClient();\nexport default prisma;\n' };

// ---------------------------------------------------------------------------------------------
// Hookdeck's filter syntax as https://hookdeck.com/docs/filters#filter-syntax documents it
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
export function matches(filter: any, data: any): boolean {
  if (filter === null || typeof filter !== "object") return Array.isArray(data) ? data.includes(filter) : data === filter;
  // a plain array: the data must be an array that contains every value
  if (Array.isArray(filter)) return Array.isArray(data) && filter.every((f) => data.some((d: unknown) => matches(f, d)));
  return Object.entries(filter).every(([key, f]: [string, any]) => {
    switch (key) {
      case "$or":
        return f.some((x: unknown) => matches(x, data));
      case "$and":
        return f.every((x: unknown) => matches(x, data));
      case "$not":
        return !matches(f, data);
      case "$eq":
        return deepEqual(data, f);
      case "$neq":
        return !deepEqual(data, f);
      case "$in":
        return typeof data === "string" || Array.isArray(data) ? data.includes(f) : false;
      case "$nin":
        return typeof data === "string" || Array.isArray(data) ? !data.includes(f) : true;
      case "$startsWith":
        return typeof data === "string" && data.startsWith(f);
      case "$endsWith":
        return typeof data === "string" && data.endsWith(f);
      case "$gt":
        return data > f;
      case "$gte":
        return data >= f;
      case "$lt":
        return data < f;
      case "$lte":
        return data <= f;
      case "$exist":
        return f ? data !== undefined : data === undefined;
      default:
        // a nested object; against an array, any element may match
        return Array.isArray(data) ? data.some((d) => matches({ [key]: f }, d)) : data !== null && typeof data === "object" && matches(f, data[key]);
    }
  });
}
// a filter rule passes an event when every part it sets matches
const passes = (rule: any, event: { headers: Record<string, string>; path: string }) => ["headers", "body", "query", "path"].every((part) => rule[part] === undefined || matches(rule[part], (event as any)[part]));

describe("the filter evaluator agrees with the examples in Hookdeck's filter docs", () => {
  const examples: [unknown, unknown, boolean][] = [
    [false, false, true],
    [{ type: "order/created" }, { type: "order/created", order: { id: 123 } }, true],
    [{ product: { inventory: 0 } }, { product: { title: "A product", inventory: 0 } }, true],
    [{ order: { items: { id: 456 } } }, { order: { id: 123, items: [{ id: 456, title: "My product" }] } }, true],
    [{ product: { tags: "gift" } }, { product: { title: "Gift Card", tags: ["gift", "something"] } }, true],
    [{ product: { tags: ["gift", "something"] } }, { product: { title: "Gift Card", tags: ["gift", "something", "another"] } }, true],
    [{ $in: "/path" }, "/path/test", true],
    [{ product: { inventory: { $lte: 10 } } }, { product: { title: "A product", inventory: 5 } }, true],
    [{ product: { inventory: { $or: [1, 5] } } }, { product: { title: "A product", inventory: 5 } }, true],
    [{ $or: [{ hello: "world" }, { hello: "mark" }] }, { hello: "world" }, true],
    [{ $or: [{ hello: "world" }, { hello: "mark" }] }, { hello: "other" }, false],
    [{ old_inventory: { $exist: false } }, { inventory: 0 }, true],
    [{ $not: { inventory: 1 } }, { inventory: 0 }, true],
    [{ $not: { event: { subtype: { $or: ["message_changed", "message_deleted"] } } } }, { event: { type: "message", subtype: "message_changed" } }, false],
    [{ $not: { event: { subtype: { $or: ["message_changed", "message_deleted"] } } } }, { event: { type: "message", subtype: "message_sent" } }, true],
  ];
  for (const [filter, data, expected] of examples) it(`${JSON.stringify(filter)} on ${JSON.stringify(data)} is ${expected ? "Not Filtered" : "Filtered"}`, () => assert.equal(matches(filter, data), expected));
});

describe("references/platforms/hookdeck.md", () => {
  it("typechecks every TypeScript block", () => {
    typecheck(here, writeProject("hookdeck.md", join(here, ".typecheck/blocks"), services), { types: ["node"] });
  });
});

describe("scripts/hookdeck.ts against a stand-in API", () => {
  let server: Server;
  let mod: any;
  const requests: { method: string; path: string; body?: any }[] = [];
  let connections: any[] = [];
  let destination: any;
  let alterNextPut = false;

  const spec = JSON.parse(readFileSync(join(here, "hookdeck-openapi-subset.json"), "utf8"));
  // VerificationConfig is a oneOf with additionalProperties: false and no properties of its own, which rejects
  // every config as written; an HTTP destination's config is DestinationTypeConfigHTTP
  spec.components.schemas.VerificationConfig = { $ref: "#/components/schemas/DestinationTypeConfigHTTP" };
  // OpenAPI 3.0's nullable becomes JSON Schema's type: [..., "null"], and refs point into the added schema
  const fix = (schema: any): any => {
    if (Array.isArray(schema)) return schema.map(fix);
    if (!schema || typeof schema !== "object") return schema;
    const out: any = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === "nullable") continue;
      if (key === "$ref") out.$ref = String(value).replace("#/components/", "hookdeck#/components/");
      else out[key] = fix(value);
    }
    if (schema.nullable && typeof schema.type === "string") out.type = [schema.type, "null"];
    else if (schema.nullable && !schema.type && (schema.anyOf || schema.oneOf || schema.$ref)) return { anyOf: [{ type: "null" }, out] };
    if (schema.nullable && Array.isArray(schema.enum)) out.enum = [...schema.enum, null];
    return out;
  };
  const ajv = new Ajv({ strict: false, allErrors: true });
  ajv.addSchema({ components: fix(spec.components) }, "hookdeck");
  const validConnectionPut = ajv.compile(fix(spec.roots.updateConnectionBody));
  const validDestinationPut = ajv.compile(fix(spec.roots.updateDestinationBody));

  const retry = { type: "retry", strategy: "exponential", interval: 60000, count: 10 };
  const dedupe = { type: "deduplicate", window: 3600000, include_fields: ["headers.x-shopify-webhook-id"] };
  const good = () => [
    { id: "web_new", name: "shopify-to-new-app", rules: [retry, dedupe], paused_at: null, disabled_at: null, source: { type: "SHOPIFY" }, destination: { id: "des_new", config: { url: "https://app.example.com", path_forwarding_disabled: false, auth_type: "HOOKDECK_SIGNATURE" } } },
    { id: "web_gadget", name: "shopify-to-gadget-orders-updated", rules: [retry, dedupe], paused_at: null, disabled_at: null, source: { type: "SHOPIFY" }, destination: { id: "des_gadget", config: { url: "https://webhooks.gadget-services.net/shopify/v1/shopifyOrder-update?domain=my-app.gadget.app", path_forwarding_disabled: true, auth_type: "HOOKDECK_SIGNATURE" } } },
  ];

  before(async () => {
    server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const url = new URL(req.url!, `http://127.0.0.1:${PORT}`);
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method!, path: url.pathname + url.search, body });
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      assert.equal(req.headers.authorization, "Bearer standin-key");
      if (req.method === "GET" && url.pathname === "/connections") return send(200, { models: connections, count: connections.length, pagination: {} });
      const conn = url.pathname.match(/^\/connections\/([\w-]+)$/);
      if (conn && req.method === "PUT") {
        if (!validConnectionPut(body)) return send(422, { message: ajv.errorsText(validConnectionPut.errors) });
        const c = connections.find((x) => x.id === conn[1]);
        // Hookdeck returns rules with its own key order, as in its docs' examples
        c.rules = body.rules.map((r: any) => Object.fromEntries(Object.entries(r).reverse()));
        if (alterNextPut) {
          alterNextPut = false;
          c.rules = c.rules.filter((r: any) => r.type !== "filter");
        }
        return send(200, c);
      }
      if (req.method === "GET" && url.pathname === "/events") {
        const headers = JSON.parse(url.searchParams.get("headers") ?? "{}");
        const status = url.searchParams.getAll("status");
        assert.equal(status.length, 1, "one status per request");
        const models = url.searchParams.get("webhook_id") === "web_gadget" && headers["x-shopify-shop-domain"] === "store-a.myshopify.com" && status[0] === "QUEUED" ? [{ id: "evt_1", status: "QUEUED" }] : [];
        return send(200, { models, count: models.length, pagination: {} });
      }
      const dest = url.pathname.match(/^\/destinations\/([\w-]+)$/);
      if (dest && req.method === "GET") return send(200, destination);
      if (dest && req.method === "PUT") {
        if (!validDestinationPut(body)) return send(422, { message: ajv.errorsText(validDestinationPut.errors) });
        destination = { ...destination, config: { ...destination.config, ...body.config } };
        return send(200, destination);
      }
      send(404, { message: `no route for ${req.method} ${url.pathname}` });
    });
    await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
    process.env.HOOKDECK_API_URL = `http://127.0.0.1:${PORT}`;
    process.env.HOOKDECK_API_KEY = "standin-key";
    // the scripts' Prisma client reads DATABASE_URL when it's created, so point it at a scratch database first
    if (ADMIN_URL) {
      const { PrismaClient } = await import("@prisma/client");
      const root = new PrismaClient({ datasourceUrl: ADMIN_URL });
      await root.$executeRawUnsafe("drop database if exists hookdeck_cleanup_test with (force)");
      await root.$executeRawUnsafe("create database hookdeck_cleanup_test");
      await root.$disconnect();
      process.env.DATABASE_URL = TEST_URL;
    }
    const dir = join(here, ".typecheck/standin");
    writeProject("hookdeck.md", dir, { ...services, "entry.ts": 'export * from "./scripts/hookdeck";\nexport { pruneProcessedWebhooks } from "./app/jobs/prune-processed-webhooks.server";\nexport { default as prisma } from "./app/db.server";\n' });
    await build({ entryPoints: [join(dir, "entry.ts")], bundle: true, platform: "node", format: "esm", packages: "external", outfile: join(dir, "bundle.mjs"), logLevel: "silent" });
    mod = await import(join(dir, "bundle.mjs"));
  });

  after(async () => {
    await mod?.prisma.$disconnect();
    await new Promise((resolve) => server.close(resolve));
    if (ADMIN_URL) {
      const { PrismaClient } = await import("@prisma/client");
      const root = new PrismaClient({ datasourceUrl: ADMIN_URL });
      await root.$executeRawUnsafe("drop database if exists hookdeck_cleanup_test with (force)");
      await root.$disconnect();
      process.env.DATABASE_URL = ADMIN_URL;
    }
  });

  it("writes filters that put every store in exactly one connection, from one list", async () => {
    connections = good();
    const before = requests.length;
    const preview = await mod.writeFilters(["Store-A.myshopify.com ", "my-test-store.myshopify.com"]);
    assert.equal(requests.slice(before).filter((r) => r.method === "PUT").length, 0, "a dry run writes nothing");
    assert.match(preview[0], /^shopify-to-new-app: /);
    assert.deepEqual(await mod.writeFilters(["store-a.myshopify.com", "my-test-store.myshopify.com"], true), ["shopify-to-new-app: wrote 2 stores", "shopify-to-gadget-orders-updated: wrote 2 stores"]);
    const [app, gadget] = connections;
    // the retry and deduplicate rules survive the write
    assert.deepEqual(app.rules.map((r: any) => r.type), ["filter", "retry", "deduplicate"]);
    const appFilter = app.rules.find((r: any) => r.type === "filter");
    const gadgetFilter = gadget.rules.find((r: any) => r.type === "filter");
    assert.deepEqual(appFilter.headers, { "x-shopify-shop-domain": { $or: ["my-test-store.myshopify.com", "store-a.myshopify.com"] } });
    for (const shop of ["my-test-store.myshopify.com", "store-a.myshopify.com", "store-b.myshopify.com", "my-store-a.myshopify.com"]) {
      const event = { headers: { "x-shopify-shop-domain": shop, "x-shopify-topic": "orders/updated" }, path: "/webhooks/orders/updated" };
      const moved = shop === "store-a.myshopify.com" || shop === "my-test-store.myshopify.com";
      assert.equal(passes(appFilter, event), moved, `${shop} to the new app`);
      assert.equal(passes(gadgetFilter, event), !moved, `${shop} to Gadget`);
      // a Gadget connection only carries its own subscription's path
      assert.equal(passes(gadgetFilter, { ...event, path: "/webhooks/products/update" }), false);
    }
    // a second write replaces the filter in place
    await mod.writeFilters(["store-a.myshopify.com", "my-test-store.myshopify.com", "store-b.myshopify.com"], true);
    assert.deepEqual(app.rules.map((r: any) => r.type), ["filter", "retry", "deduplicate"]);
  });

  it("shows why plain arrays and $in are wrong for shop filters", () => {
    const event = (shop: string) => ({ headers: { "x-shopify-shop-domain": shop }, path: "/webhooks/orders/updated" });
    const plain = { type: "filter", headers: { "x-shopify-shop-domain": ["my-test-store.myshopify.com", "store-a.myshopify.com"] } };
    assert.equal(passes(plain, event("store-a.myshopify.com")), false);
    assert.equal(passes(plain, event("my-test-store.myshopify.com")), false);
    const contains = { type: "filter", headers: { "x-shopify-shop-domain": { $in: "store-a.myshopify.com" } } };
    assert.equal(passes(contains, event("my-store-a.myshopify.com")), true);
  });

  it("refuses an empty list, a bad domain, a missing connection, a missing retry rule, and a filter Hookdeck didn't keep", async () => {
    connections = good();
    assert.throws(() => mod.storeFilters([]), /insert your test store into moved_store first/);
    assert.throws(() => mod.storeFilters(["store-a.example.com"]), /not a myshopify\.com domain: store-a\.example\.com/);
    connections = [good()[0]];
    await assert.rejects(mod.writeFilters(["store-a.myshopify.com"], true), /no Hookdeck connection named shopify-to-gadget-orders-updated/);
    connections = good();
    connections[1].rules = [dedupe];
    await assert.rejects(mod.writeFilters(["store-a.myshopify.com"], true), /shopify-to-gadget-orders-updated has no retry rule/);
    connections = good();
    alterNextPut = true;
    await assert.rejects(mod.writeFilters(["store-a.myshopify.com"], true), /Hookdeck stored different rules than the ones sent/);
  });

  it("audits connections for each pitfall", async () => {
    connections = good();
    await mod.writeFilters(["store-a.myshopify.com"], true);
    assert.deepEqual(await mod.audit(), []);
    connections = good();
    connections[0] = { ...connections[0], source: { type: "WEBHOOK" }, paused_at: "2026-11-10T00:00:00Z", rules: [{ ...retry, response_status_codes: ["500-599"] }, { ...dedupe, window: 3600 }, { type: "transform", transformation_id: "trs_1" }], destination: { id: "des_new", config: { url: "https://app.example.com/webhooks/orders/updated", auth_type: "BEARER_TOKEN" } } };
    connections[1] = { ...connections[1], rules: [], destination: { id: "des_gadget", config: { url: connections[1].destination.config.url, path_forwarding_disabled: false } } };
    assert.deepEqual(await mod.audit(), [
      "shopify-to-new-app: source type WEBHOOK doesn't check Shopify's signature",
      "shopify-to-new-app: paused or disabled",
      "shopify-to-new-app: retries only 500-599",
      "shopify-to-new-app: deduplicate window is 3600 ms",
      "shopify-to-new-app: a transform rule breaks Shopify's HMAC",
      "shopify-to-new-app: no store filter",
      "shopify-to-new-app: destination URL has the path /webhooks/orders/updated",
      "shopify-to-new-app: destination auth BEARER_TOKEN sends no x-hookdeck-signature",
      "shopify-to-gadget-orders-updated: no retry rule",
      "shopify-to-gadget-orders-updated: no deduplicate rule",
      "shopify-to-gadget-orders-updated: no store filter",
      "shopify-to-gadget-orders-updated: path forwarding is on, so Gadget gets the path added to its URL",
    ]);
  });

  it("lists a store's events still waiting for Gadget", async () => {
    connections = good();
    assert.deepEqual(await mod.pending("store-a.myshopify.com"), [{ id: "evt_1", status: "QUEUED" }]);
    assert.deepEqual(await mod.pending("store-b.myshopify.com"), []);
    assert.ok(requests.some((r) => r.path.startsWith("/events?webhook_id=web_gadget&status=SCHEDULED&headers=")));
    assert.ok(!requests.some((r) => r.path.includes("webhook_id=web_new")), "only the Gadget connections");
  });

  it("sets a per-store delivery policy with a body Hookdeck's schema accepts, keeping the destination's settings", async () => {
    destination = { id: "des_gadget", type: "HTTP", config: { url: "https://webhooks.gadget-services.net/shopify/v1/shopifyOrder-update?domain=my-app.gadget.app", path_forwarding_disabled: true, delivery_timeout: 120, auth_type: "HOOKDECK_SIGNATURE", auth: {} } };
    await mod.setDeliveryPolicy("des_gadget");
    const put = requests.filter((r) => r.method === "PUT" && r.path === "/destinations/des_gadget").pop()!;
    assert.deepEqual(put.body, { config: { url: destination.config.url, delivery_policy: { rate: 20, period: "second", groups: { key: "headers.x-shopify-shop-domain", rate: 2, rate_period: "second" } }, path_forwarding_disabled: true, delivery_timeout: 120 } });
    await mod.setDeliveryPolicy("des_gadget", { rate: 10, period: "concurrent", groupRate: 1 });
    assert.equal(destination.config.delivery_policy.period, "concurrent");
    // the guide's curl body has no url, which the schema marks required
    assert.equal(validDestinationPut({ config: { delivery_policy: { rate: 20, period: "second" } } }), false);
  });

  it("matches the deduplicate window limits in Hookdeck's schema", () => {
    assert.equal(validConnectionPut({ rules: [{ ...dedupe, window: 3600 }] }), true, "3600 is accepted, as 3.6 seconds");
    assert.equal(validConnectionPut({ rules: [{ ...dedupe, window: 60 }] }), false, "60 is below the 1000 ms minimum");
    assert.equal(validConnectionPut({ rules: [{ ...dedupe, window: 3600000 }] }), true);
    assert.equal(validConnectionPut({ rules: [{ ...dedupe, window: 7200000 }] }), false, "over the 1-hour maximum");
  });

  describe("the processed_webhook cleanup", { skip: !ADMIN_URL && "set DATABASE_URL to a Postgres superuser URL" }, () => {
    before(async () => {
      const { PrismaClient } = await import("@prisma/client");
      const db = new PrismaClient({ datasourceUrl: TEST_URL });
      // the table from references/shopify-webhooks.md, then this reference's migration, one statement at a time
      const statements = [block("../shopify-webhooks.md", "db/migrations/processed_webhook.sql"), block("hookdeck.md", "db/migrations/hookdeck_store_cutover.sql")]
        .join("\n")
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .split(";")
        .map((statement) => statement.trim())
        .filter(Boolean);
      for (const statement of statements) await db.$executeRawUnsafe(statement);
      await db.$executeRawUnsafe("insert into processed_webhook (webhook_id, received_at) select 'old-' || n, now() - interval '10 days' from generate_series(1, 25000) n");
      await db.$executeRawUnsafe("insert into processed_webhook (webhook_id, received_at) select 'mid-' || n, now() - interval '20 days' from generate_series(1, 50) n");
      await db.$executeRawUnsafe("insert into processed_webhook (webhook_id, received_at) select 'new-' || n, now() - interval '2 days' from generate_series(1, 100) n");
      await db.$disconnect();
    });

    it("keeps rows for the plan's retention plus a day, at least a week, and deletes the rest in batches", async () => {
      const count = async () => Number((await mod.prisma.$queryRawUnsafe("select count(*)::int as n from processed_webhook"))[0].n);
      await assert.rejects(mod.pruneProcessedWebhooks(Number(undefined)), /set HOOKDECK_RETENTION_DAYS/);
      await assert.rejects(mod.pruneProcessedWebhooks(0), /set HOOKDECK_RETENTION_DAYS/);
      // 30 days of retention: 31 days kept, so nothing goes
      assert.equal(await mod.pruneProcessedWebhooks(30), 0);
      // 7 days of retention: 8 days kept, in batches of 10,000
      assert.equal(await mod.pruneProcessedWebhooks(7, 10_000), 25_050);
      assert.equal(await count(), 100);
    });

    it("rejects a moved store whose domain would match no webhook", async () => {
      await mod.prisma.$executeRawUnsafe("insert into moved_store (shop_domain) values ('store-a.myshopify.com')");
      await assert.rejects(mod.prisma.$executeRawUnsafe("insert into moved_store (shop_domain) values ('Store-B.myshopify.com ')"), /moved_store_shop_domain_check/);
    });
  });
});
