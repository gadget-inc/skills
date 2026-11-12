// Runs the per-store subscription script from cutover.md against a fake Admin API client, and
// validates its GraphQL against Shopify's published Admin API schema.
//
//   cd tests/gadget-migration/cutover && npm install && npm test
//
// The schema test needs network access to shopify.dev and is skipped without it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { before, test } from "node:test";
import { buildClientSchema, getIntrospectionQuery, parse, validate } from "graphql";

const API_VERSION = "2026-10"; // the version Shopify's React Router template pins
const reference = new URL("../../../skills/gadget/gadget-migration/references/cutover.md", import.meta.url);
const markdown = readFileSync(reference, "utf8");
const block = [...markdown.matchAll(/```typescript\n([\s\S]*?)```/g)].map((match) => match[1]).find((code) => code.startsWith("// in scripts/delete-store-subscriptions.ts\n"));
assert.ok(block, "no code block for scripts/delete-store-subscriptions.ts in cutover.md");

type Subscription = { id: string; topic: string; uri: string };
let deleteStoreSubscriptions: (admin: any, keepPrefix: string, dryRun?: boolean) => Promise<Subscription[]>;

before(async () => {
  const js = (nodeModule as any).stripTypeScriptTypes(block) as string;
  ({ deleteStoreSubscriptions } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`));
});

// A store with three per-store subscriptions served two per page, the way Shopify pages them.
function fakeAdmin(subscriptions: Subscription[], failDeleteOf?: string) {
  const store = [...subscriptions];
  const calls: { query: string; variables: any }[] = [];
  const admin = {
    graphql: async (query: string, options?: { variables?: Record<string, any> }) => {
      calls.push({ query, variables: options?.variables });
      if (query.includes("webhookSubscriptionDelete")) {
        const id = options!.variables!.id;
        if (id === failDeleteOf) {
          return Response.json({ data: { webhookSubscriptionDelete: { deletedWebhookSubscriptionId: null, userErrors: [{ field: ["id"], message: "Webhook subscription does not exist" }] } } });
        }
        store.splice(store.findIndex((subscription) => subscription.id === id), 1);
        return Response.json({ data: { webhookSubscriptionDelete: { deletedWebhookSubscriptionId: id, userErrors: [] } } });
      }
      const start = options?.variables?.after ? store.findIndex((subscription) => subscription.id === options.variables!.after) + 1 : 0;
      const nodes = store.slice(start, start + 2);
      const hasNextPage = start + 2 < store.length;
      return Response.json({ data: { webhookSubscriptions: { nodes, pageInfo: { hasNextPage, endCursor: nodes.at(-1)?.id ?? null } } } });
    },
  };
  return { admin, store, calls };
}

const NEW_APP = "https://new-app.example.com";
const SUBSCRIPTIONS: Subscription[] = [
  { id: "gid://shopify/WebhookSubscription/1", topic: "ORDERS_CREATE", uri: "https://my-app.gadget.app/api/webhooks/shopify" },
  { id: "gid://shopify/WebhookSubscription/2", topic: "PRODUCTS_UPDATE", uri: `${NEW_APP}/webhooks/products/update` },
  { id: "gid://shopify/WebhookSubscription/3", topic: "ORDERS_UPDATED", uri: "https://my-app.gadget.app/api/webhooks/shopify" },
];

test("a dry run lists Gadget's subscriptions from every page and deletes nothing", async () => {
  const { admin, store, calls } = fakeAdmin(SUBSCRIPTIONS);
  const stale = await deleteStoreSubscriptions(admin, NEW_APP);
  assert.deepEqual(stale.map((subscription) => subscription.topic), ["ORDERS_CREATE", "ORDERS_UPDATED"]);
  assert.equal(store.length, 3);
  assert.equal(calls.filter((call) => call.query.includes("webhookSubscriptionDelete")).length, 0);
  assert.equal(calls.length, 2); // followed endCursor to the second page
});

test("a real run deletes Gadget's subscriptions and keeps the new app's", async () => {
  const { admin, store } = fakeAdmin(SUBSCRIPTIONS);
  await deleteStoreSubscriptions(admin, NEW_APP, false);
  assert.deepEqual(store.map((subscription) => subscription.uri), [`${NEW_APP}/webhooks/products/update`]);
});

test("a store with no per-store subscriptions is left alone", async () => {
  const { admin, calls } = fakeAdmin([]);
  assert.deepEqual(await deleteStoreSubscriptions(admin, NEW_APP, false), []);
  assert.equal(calls.length, 1);
});

test("a userError from Shopify stops the run instead of passing silently", async () => {
  const { admin } = fakeAdmin(SUBSCRIPTIONS, "gid://shopify/WebhookSubscription/1");
  await assert.rejects(deleteStoreSubscriptions(admin, NEW_APP, false), /ORDERS_CREATE: Webhook subscription does not exist/);
});

test(`the script's GraphQL is valid on Admin API ${API_VERSION}`, async (t) => {
  let introspection: any;
  try {
    const response = await fetch(`https://shopify.dev/admin-graphql-direct-proxy/${API_VERSION}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: getIntrospectionQuery() }),
      signal: AbortSignal.timeout(30_000),
    });
    introspection = (await response.json()).data;
  } catch (error) {
    return t.skip(`could not reach shopify.dev: ${error}`);
  }
  if (!introspection?.__schema) return t.skip("shopify.dev did not return a schema");
  const schema = buildClientSchema(introspection);

  const documents = [...block!.matchAll(/`#graphql\n([\s\S]*?)`/g)].map((match) => match[1]);
  assert.equal(documents.length, 2);
  for (const document of documents) {
    assert.deepEqual(validate(schema, parse(document)).map((error) => error.message), []);
  }
  // guard against the validator passing everything: a field that doesn't exist must fail
  assert.notEqual(validate(schema, parse("{ webhookSubscriptions(first: 1) { nodes { notAField } } }")).length, 0);
  // `uri` is the field the script filters on, and `callbackUrl` is the deprecated one it replaced
  const fields = (schema.getType("WebhookSubscription") as any).getFields();
  assert.equal(fields.uri.deprecationReason ?? null, null);
  assert.ok(fields.callbackUrl.deprecationReason);
});
