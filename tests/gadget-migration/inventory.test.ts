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
    assert.match(output, /Webhook topics \(2\): `orders\/create`, `orders\/updated`/);
    assert.match(output, /Compliance topics: `customers\/data_request`, `customers\/redact`, `shop\/redact`/);
    assert.match(output, /include_fields/);
    assert.match(output, /App proxy configured/);
  });

  it("lists models and flags fields that need extra steps", () => {
    assert.match(output, /## Models \(4\)/);
    // no semicolons and a value import: the import is dropped and the schema still loads
    assert.match(output, /\| `gizmo` \| custom \| 1 string, 1 number \|/);
    assert.doesNotMatch(output, /could not load/);
    assert.match(output, /\| `shopifyOrder` \| Shopify \| 1 boolean \| 4 synced Shopify fields/);
    for (const field of ["widget.apiSecret` \\(encryptedString\\)", "widget.embedding` \\(vector\\)", "widget.displayName` \\(computed\\)", "widget.manual` \\(file\\)", "user.password` \\(password\\)", "user.roles` \\(roleList\\)"]) {
      assert.match(output, new RegExp(field));
    }
    assert.match(output, /`widget\.tags` \(enum, multiple values\): use `text\[\]`/);
    assert.match(output, /`widget\.sku` is unique per `shop`/);
    assert.match(output, /`widget\.shop` belongs to `shopifyShop`/);
  });

  it("finds triggers, background jobs, and schedules in actions", () => {
    assert.match(output, /`models\/shopifyOrder\/actions\/create` \| not callable from the API; webhooks: orders\/create; checks record\.changed; shop tenancy check; has onSuccess \|/);
    assert.match(output, /enqueues `api\.notifyExternalSystem` with `queue`, `maxConcurrency`, `retries`, `id`/);
    assert.match(output, /`actions\/pruneAuditLogs`: `\[\{ every: "day", at: "02:00 UTC" \}\]`/);
    assert.match(output, /`actions\/pruneAuditLogs` \| not callable from the API; scheduled; timeoutMS 900000; calls Shopify \|/);
  });

  it("maps route files to paths", () => {
    assert.match(output, /`GET \/` from `api\/routes\/GET\.ts`/);
    assert.match(output, /`GET \/products\/:id` from `api\/routes\/products\/GET-\[id\]\.ts`/);
    assert.match(output, /`POST \/webhooks\/stripe`/);
    assert.match(output, /Route plugin `api\/routes\/\+scope\.ts`/);
  });

  it("lists roles, filters, frontend hooks, and environment variables", () => {
    // the fixture's permissions file is indented with tabs
    assert.match(output, /Roles: `shopify-app-users`, `unauthenticated`/);
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
