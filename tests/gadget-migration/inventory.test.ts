// Run with: node --test "tests/**/*.test.ts"
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const script = fileURLToPath(new URL("../../skills/gadget/gadget-migration/scripts/inventory.ts", import.meta.url));
const app = fileURLToPath(new URL("./fixtures/sample-app", import.meta.url));
const output = execFileSync(process.execPath, [script, app], { encoding: "utf8" });

describe("inventory.ts on the sample app", () => {
  it("reads app settings and shopify.app.toml", () => {
    assert.match(output, /Framework version: `v1\.7\.0`/);
    assert.match(output, /Shopify API version: `2026-04`/);
    assert.match(output, /Email and password sign-in/);
    // settings files name the method googleOAuth, not google
    assert.match(output, /Google sign-in \(see references\/users-and-auth\.md\)/);
    assert.match(output, /Full text search \(`search` or `searchFields`\) in 1 file: `web\/routes\/index\.tsx` \(see references\/search\.md\)/);
    assert.match(output, /## Callers outside this repository/);
    assert.match(output, /Webhook topics \(2\): `orders\/create`, `orders\/updated`/);
    assert.match(output, /Compliance topics: `customers\/data_request`, `customers\/redact`, `shop\/redact`/);
    assert.match(output, /include_fields/);
    assert.match(output, /App proxy configured/);
  });

  it("lists models and flags fields that need extra steps", () => {
    assert.match(output, /## Models \(9\)/);
    // no semicolons and a value import: the import is dropped and the schema still loads
    assert.match(output, /\| `gizmo` \| `gizmo` \| custom \| 1 string, 1 number \| export from production \|/);
    assert.doesNotMatch(output, /could not load/);
    for (const field of ["widget.apiSecret` \\(encryptedString\\)", "widget.embedding` \\(vector\\)", "widget.displayName` \\(computed\\)", "user.password` \\(password\\)", "user.roles` \\(roleList\\)", "billing/invoice.notes` \\(richText\\)"]) {
      assert.match(output, new RegExp(field));
    }
    assert.match(output, /`widget\.tags` \(enum, multiple values\): use `text\[\]`/);
    assert.match(output, /`widget\.shop` belongs to `shopifyShop`/);
  });

  it("separates what to export from what Shopify can backfill", () => {
    // only the field the app added is exported; the metafield field comes back with the backfill
    assert.match(output, /\| `shopifyOrder` \| `shopify_order` \| Shopify \| 1 boolean \| backfill the 4 Shopify fields from Shopify; export only `reviewed`, with `id` \|/);
    assert.match(output, /\| `shopifyProduct` \| `shopify_product` \| Shopify \| [^|]+ \| backfill the 3 Shopify fields and 1 metafield field from Shopify; export only `featured`, with `id` \|/);
    assert.match(output, /`shopifyProduct\.careGuide` holds the Shopify metafield `custom\.care_guide`: backfill it from Shopify/);
    // records Shopify can't give back are not marked for backfill
    assert.match(output, /\| `shopifySync` \| `shopify_sync` \| Gadget-managed \|/);
    assert.match(output, /\| `session` \| `session` \| session \| 1 roleList \| don't export/);
    // a custom model whose name starts with "shopify" still needs exporting
    assert.match(output, /\| `shopifyHelper` \| `shopify_helper` \| custom \| 1 string \| export from production \|/);
  });

  it("handles namespaced models and reserved table names", () => {
    assert.match(output, /\| `billing\/invoice` \| `billing_invoice` \| custom \|/);
    assert.match(output, /`billing\/invoice\.widget` belongs to `widget`/);
    // `create table user` is a syntax error in Postgres
    assert.match(output, /\| `user` \| `users` \| custom \|/);
  });

  it("reads the field options that change the column or index", () => {
    assert.match(output, /`widget\.sku` is unique per `shop`, ignoring case: add a unique index on `lower\(\.\.\.\)`/);
    assert.match(output, /`user\.email` is unique, ignoring case/);
    assert.match(output, /`billing\/invoice\.number` is unique: add a unique index \(/); // caseSensitive: true
    assert.match(output, /`billing\/invoice\.dueOn` \(dateTime without a time\): use `date`/);
    assert.match(output, /`billing\/invoice\.status` \(enum\) accepts values outside its options/);
    assert.match(output, /`widget\.manual` \(file\): [^\n]*private URLs expire after 3 hours/);
    assert.match(output, /`billing\/invoice\.receipt` \(file\): [^\n]*these URLs are public/);
    assert.match(output, /`api\/views\/widgetCount\.gelly`: rewrite as a SQL query or view/);
  });

  it("finds triggers, background jobs, and schedules in actions", () => {
    assert.match(output, /`models\/shopifyOrder\/actions\/create` \| not callable from the API; webhooks: orders\/create; checks record\.changed; shop tenancy check; has onSuccess \|/);
    assert.match(output, /enqueues `api\.notifyExternalSystem` with `queue`, `maxConcurrency`, `retries`, `id`/);
    assert.match(output, /`actions\/pruneAuditLogs`: `\[\{ every: "day", at: "02:00 UTC" \}\]`/);
    assert.match(output, /`actions\/pruneAuditLogs` \| not callable from the API; scheduled; timeoutMS 900000; calls Shopify \|/);
  });

  it("reports webhook filters from the TOML and from action triggers", () => {
    // framework 1.7 and later keep a filter on the subscription in shopify.app.toml
    assert.match(output, /- Webhook filter `financial_status:paid`: keep it on the new subscription/);
    // earlier versions, and models with metafield fields, keep it in the action's trigger. Quotes inside the filter survive
    assert.match(output, /`models\/shopifyProduct\/actions\/update`: `products\/update` \(shopifyFilter `vendor:"Nike Air" AND variants\.price:>=10\.00`: set it as the subscription's `filter`\)/);
    assert.match(output, /`models\/shopifyProduct\/actions\/update` \| not callable from the API; webhooks: products\/update; filters webhooks with shopifyFilter; shop tenancy check \|/);
    // an action without a filter gets no note
    assert.doesNotMatch(output, /shopifyOrder\/actions\/create`[^\n]*shopifyFilter/);
  });

  it("says where the Shopify API version and the belongsTo indexes go", () => {
    assert.match(output, /Shopify API version: `2026-04`\. Set the new app's `apiVersion` and the `\[webhooks\]` `api_version`/);
    assert.match(output, /### Relationships \([^\n]*index each of these columns/);
  });

  it("maps route files to paths", () => {
    assert.match(output, /`GET \/` from `api\/routes\/GET\.ts`/);
    assert.match(output, /`GET \/products\/:id` from `api\/routes\/products\/GET-\[id\]\.ts`/);
    assert.match(output, /`POST \/webhooks\/stripe`/);
    assert.match(output, /Route plugin `api\/routes\/\+scope\.ts`/);
  });

  it("lists roles, filters, frontend hooks, and environment variables", () => {
    // the fixture's permissions file is indented with tabs
    // the CSV export writes role keys, so a key that differs from the name is shown
    assert.match(output, /Roles: `shopify-app-users` \(key `Role-Shopify-App`\), `unauthenticated`/);
    assert.match(output, /Gelly filter: `accessControl\/filters\/shopify\/widget\.gelly`/);
    assert.match(output, /2 files import the Gadget client/);
    assert.match(output, /`useFindMany`: 1 uses/);
    assert.match(output, /`useFindOne`: 1 uses/); // from the older frontend/ folder
    assert.match(output, /`live: true`: 1 live queries/);
    assert.match(output, /`EXTERNAL_WEBHOOK_URL`: copy the value/);
    assert.match(output, /`STRIPE_SECRET`: copy the value/);
    assert.match(output, /`VITE_DEFAULT_NAME`: copy the value/);
    assert.match(output, /`GADGET_ENV`: set by Gadget/);
  });

  it("lists extensions that still call the Gadget app", () => {
    assert.match(output, /- `extensions\/checkout-banner\/src\/Checkout\.tsx`/);
  });
});
