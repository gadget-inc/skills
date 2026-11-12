// Run with: node --test "tests/**/*.test.ts"
// Runs the Hookdeck route code from references/shopify-webhooks.md with the real verifyWebhook
// and a stand-in for authenticate.webhook that reads the body the way the template's does.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import * as nodeModule from "node:module";
import { describe, it } from "node:test";
import { verifyWebhook } from "../../skills/gadget/gadget-migration/assets/shopify-signatures.ts";
import { blocks } from "./coverage-snippets.ts";

const source = blocks("shopify-webhooks.md", "app/routes/webhooks.orders.updated.tsx").find((block) => block.includes("x-hookdeck-signature"));
assert.ok(source, "no Hookdeck block in shopify-webhooks.md");
const strip = (nodeModule as any).stripTypeScriptTypes as (code: string) => string;
// the block is the body of a route action, so wrap it in one before stripping its types
const wrapped = `async function route(request, verifyWebhook, authenticate, process) {\n${source}\nreturn { shop, payload, webhookId };\n}`;
const route = new Function(`${strip(wrapped)}\nreturn route;`)();

const SECRET = "hookdeck-project-secret";
const env = { env: { HOOKDECK_WEBHOOK_SECRET: SECRET } };
// Shopify sends JSON with no spaces, and Hookdeck forwards the same bytes
const body = '{"id":5123456789,"total_price":"42.50","note":"café"}';
const sign = (text: string, secret = SECRET) => createHmac("sha256", secret).update(text).digest("base64");

// reads the original request's body, as the template's authenticate.webhook does
const authenticate = {
  webhook: async (request: Request) => ({
    shop: request.headers.get("x-shopify-shop-domain"),
    payload: JSON.parse(await request.text()),
    webhookId: request.headers.get("x-shopify-webhook-id"),
  }),
};
const delivery = (headers: Record<string, string>, text = body) =>
  new Request("https://my-new-app.example.com/webhooks/orders/updated", {
    method: "POST",
    headers: { "x-shopify-shop-domain": "store-a.myshopify.com", "x-shopify-webhook-id": "b54557e4", ...headers },
    body: text,
  });
const run = (request: Request) => route(request, verifyWebhook, authenticate, env);

describe("Hookdeck route code in shopify-webhooks.md", () => {
  it("accepts a delivery signed with the project secret, and leaves the body for authenticate.webhook", async () => {
    const result = await run(delivery({ "x-hookdeck-signature": sign(body) }));
    assert.deepEqual(result, { shop: "store-a.myshopify.com", payload: JSON.parse(body), webhookId: "b54557e4" });
  });

  it("accepts x-hookdeck-signature-2 while a rolled secret is still active", async () => {
    const result = await run(delivery({ "x-hookdeck-signature": sign(body, "new-secret"), "x-hookdeck-signature-2": sign(body) }));
    assert.equal(result.webhookId, "b54557e4");
  });

  it("answers 401 to a request that did not come through Hookdeck", async () => {
    for (const headers of [{}, { "x-hookdeck-signature": sign(body, "other-project") }, { "x-hookdeck-signature": "not base64" }]) {
      const result = await run(delivery(headers));
      assert.ok(result instanceof Response);
      assert.equal(result.status, 401);
    }
  });

  it("answers 401 when the body changed after Hookdeck signed it", async () => {
    const result = await run(delivery({ "x-hookdeck-signature": sign(body) }, body.replace("42.50", "0.01")));
    assert.equal(result.status, 401);
  });
});
