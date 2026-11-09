# Verifying Shopify requests

## What is this?

On Gadget, every request from Shopify was verified before your code ran: webhook HMACs, the OAuth callback `hmac`, app proxy signatures, and the session tokens App Bridge sends. After a move, your app does these checks itself. Skip one and anyone who knows the URL can send your app a fake order or read another store's data through the proxy.

All four checks are HMAC-SHA256 with your app's **client secret** (the "API secret key" in the Partner Dashboard or Dev Dashboard). They differ in what gets signed and how the digest is encoded:

| Request | Where the signature is | What is signed | Digest |
|---|---|---|---|
| Webhook (HTTPS delivery) | `X-Shopify-Hmac-SHA256` header | The raw request body bytes | base64 |
| OAuth callback, links Shopify opens in your app | `hmac` query parameter | Other parameters, decoded, sorted by key, joined `key=value` with `&` | hex |
| App proxy request | `signature` query parameter | Other parameters, decoded, repeated keys joined with `,`, sorted `key=value`, joined with nothing | hex |
| Session token (ID token) from App Bridge | Third segment of the JWT | `header.payload` (HS256) | base64url |

[`assets/shopify-signatures.ts`](../assets/shopify-signatures.ts) implements all four with the Web Crypto API and nothing else, so the same file runs on Node 20+, Bun, Deno, Cloudflare Workers, Vercel (Node and Edge), Netlify, and AWS Lambda. Copy it into the project and keep it unchanged. Its tests check it against Shopify's own published examples: the OAuth callback example and both app proxy examples, all signed with the secret `hush`.

The only code that changes between platforms is how you get the raw body and the header. That glue is below.

## When you don't need this

If the new app uses Shopify's React Router app template, the template already does these checks:

- `authenticate.webhook(request)` verifies webhook HMACs.
- `authenticate.admin(request)` verifies session tokens.
- `authenticate.public.appProxy(request)` verifies app proxy signatures.

Use the file in this skill for routes the template doesn't cover, or when the app runs on another framework.

## Webhooks

Shopify computes the HMAC over the exact bytes it sent. Any body parser that turns the JSON into an object and back changes those bytes, and every genuine delivery then fails the check.

### ✅ Read the raw bytes, verify, then parse

```typescript
import { verifyWebhook } from "./shopify-signatures";

const valid = await verifyWebhook(rawBody, hmacHeader, process.env.SHOPIFY_CLIENT_SECRET!);
if (!valid) return new Response(null, { status: 401 });
const payload = JSON.parse(new TextDecoder().decode(rawBody));
```

### ❌ Parse first, then rebuild the body

```typescript
// express.json() already ran, so req.body is an object. JSON.stringify does not reproduce
// Shopify's bytes (whitespace, key order, number formatting), so genuine deliveries get a 401.
const rebuilt = Buffer.from(JSON.stringify(req.body));
await verifyWebhook(rebuilt, req.get("X-Shopify-Hmac-SHA256"), secret); // false
```

### Getting the raw body on each platform

**Fetch-style handlers** (Next.js route handlers, Remix and React Router actions, Hono, Cloudflare Workers, Deno, Bun, Supabase Edge Functions, SvelteKit, Astro):

```typescript
export async function POST(request: Request) {
  const rawBody = await request.arrayBuffer();
  const valid = await verifyWebhook(rawBody, request.headers.get("X-Shopify-Hmac-SHA256"), process.env.SHOPIFY_CLIENT_SECRET!);
  if (!valid) return new Response(null, { status: 401 });
  // ...queue the work, then respond
  return new Response(null, { status: 200 });
}
```

In Hono, the same calls are `await c.req.arrayBuffer()` and `c.req.header("X-Shopify-Hmac-SHA256")`.

**Express 4 and 5:** give the webhook route its own raw parser, and register it before any global `express.json()`.

```typescript
app.post("/webhooks", express.raw({ type: "application/json" }), async (req, res) => {
  const valid = await verifyWebhook(req.body, req.get("X-Shopify-Hmac-SHA256"), process.env.SHOPIFY_CLIENT_SECRET!);
  if (!valid) return res.sendStatus(401);
  const payload = JSON.parse(req.body.toString("utf8"));
  // ...queue the work
  res.sendStatus(200);
});

app.use(express.json()); // after the webhook route
```

**Fastify:** register the webhook route inside a plugin with its own buffer parser. The parser applies only to routes in that plugin, so JSON parsing stays on everywhere else.

```typescript
await app.register(async (webhooks) => {
  webhooks.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  webhooks.post("/webhooks", async (request, reply) => {
    const header = request.headers["x-shopify-hmac-sha256"];
    const valid = await verifyWebhook(request.body as Buffer, typeof header === "string" ? header : null, process.env.SHOPIFY_CLIENT_SECRET!);
    return reply.code(valid ? 200 : 401).send();
  });
});
```

**Google Cloud Functions and Cloud Run with the Functions Framework:** the framework parses JSON but keeps the original bytes on `req.rawBody`.

```typescript
const valid = await verifyWebhook(req.rawBody, req.get("X-Shopify-Hmac-SHA256"), process.env.SHOPIFY_CLIENT_SECRET!);
```

**AWS Lambda behind a function URL or an API Gateway HTTP API:** the body arrives as a string, base64-encoded when `isBase64Encoded` is true, and header names are lowercase.

```typescript
export const handler = async (event: APIGatewayProxyEventV2) => {
  const rawBody = Buffer.from(event.body ?? "", event.isBase64Encoded ? "base64" : "utf8");
  const valid = await verifyWebhook(rawBody, event.headers["x-shopify-hmac-sha256"], process.env.SHOPIFY_CLIENT_SECRET!);
  if (!valid) return { statusCode: 401 };
  // ...queue the work
  return { statusCode: 200 };
};
```

The Express, Fastify, and Hono versions above were run against real servers with signed and forged deliveries.

### Pub/Sub and EventBridge deliveries

Shopify only signs HTTPS deliveries. Webhooks delivered to Google Cloud Pub/Sub or Amazon EventBridge carry no HMAC, and the cloud provider's permissions are the check: only Shopify's service account can publish to the topic you granted it. Don't call `verifyWebhook` on those messages.

### Webhook headers you'll use

| Header | Use it for |
|---|---|
| `X-Shopify-Hmac-SHA256` | The signature |
| `X-Shopify-Topic` | Routing, such as `orders/create` |
| `X-Shopify-Shop-Domain` | Which store sent it, such as `example.myshopify.com` |
| `X-Shopify-Webhook-Id` | One delivery. Shopify resends the same id when it retries, so use it to drop duplicates |
| `X-Shopify-Event-Id` | The merchant action behind it. Two subscriptions to the same topic get different webhook ids but the same event id |
| `X-Shopify-API-Version` | The payload's API version |

See [shopify-webhooks.md](shopify-webhooks.md) for what to do after the check passes.

## OAuth callback and admin links

Only apps that run the authorization code grant themselves need this. Apps on Shopify managed installation (the template's default) never receive an OAuth callback.

```typescript
import { SHOP_DOMAIN, verifyQueryHmac } from "./shopify-signatures";

const url = new URL(request.url);
const shop = url.searchParams.get("shop") ?? "";
if (!SHOP_DOMAIN.test(shop)) return new Response("Invalid shop", { status: 400 });
if (!(await verifyQueryHmac(url.searchParams, process.env.SHOPIFY_CLIENT_SECRET!))) return new Response(null, { status: 401 });
// then compare `state` with the nonce you stored before redirecting, and reject a mismatch
```

Check `shop` against the anchored pattern before you send the authorization code anywhere. Without the trailing `$`, `example.myshopify.com.attacker.test` passes and your app posts the code to someone else's server.

The function also rejects a `timestamp` more than 90 seconds from now, the same tolerance Shopify's own library uses, so a leaked URL stops working within two minutes. Pass `{ maxAgeSeconds }` to change it.

Shopify signs the decoded values. A space travels as `%20` or `+` but is signed as a space, and `URLSearchParams` decodes both, so pass it the query as received. Repeated keys, such as `ids[]=1&ids[]=2` on an admin bulk action link, are signed once with their values joined by commas. That follows Shopify's own library and wasn't checked against a link signed by Shopify.

### ❌ Don't verify embedded app loads with the query `hmac`

When the admin loads an embedded app, Shopify adds an `id_token` to the URL, and App Bridge sends a session token on every request after that. Verify those instead. Some links append parameters after Shopify signed the URL (for example, Sidekick's `intent` parameter), so a strict query check rejects them.

## App proxy requests

```typescript
import { verifyAppProxySignature } from "./shopify-signatures";

const url = new URL(request.url);
if (!(await verifyAppProxySignature(url.searchParams, process.env.SHOPIFY_CLIENT_SECRET!))) {
  return new Response(null, { status: 401 });
}
const customerId = url.searchParams.get("logged_in_customer_id"); // empty string when nobody is logged in
```

A valid signature proves Shopify forwarded the request. It doesn't prove the customer may see the record they asked for. Check that `logged_in_customer_id` owns the data before returning it.

Shopify joins the signed `key=value` pairs with nothing between them, so one signed string can be split into parameters more than one way. For example, Shopify's documented request verifies just as well with `shop` and `timestamp` folded into the value of `logged_in_customer_id`. So after checking the signature, the function also requires `shop` to be a `*.myshopify.com` domain, `logged_in_customer_id` to be digits or empty, `timestamp` to be within 90 seconds of now, and none of them to repeat. Read those three values only after it returns `true`.

Shopify adds `shop`, `logged_in_customer_id`, `path_prefix`, `timestamp`, and `signature`, and says it may add more parameters later. The function signs whatever arrives, so new parameters don't break it.

## Session tokens

App Bridge sends a session token (Shopify now calls it an ID token) as `Authorization: Bearer <token>` on fetches from the embedded app, and as the `id_token` query parameter on the first load. Each one lasts 1 minute.

```typescript
import { verifySessionToken } from "./shopify-signatures";

const token = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
const session = await verifySessionToken(token, {
  clientId: process.env.SHOPIFY_CLIENT_ID!,
  secrets: process.env.SHOPIFY_CLIENT_SECRET!,
});
if (!session) return new Response(null, { status: 401 });
// session.shop is "example.myshopify.com"; scope every query to it
```

The function checks the signature and that `alg` is `HS256`, that `exp` is in the future and `nbf` in the past, that `aud` is your client id, and that `iss` and `dest` name the same `*.myshopify.com` store. It allows 5 seconds of clock skew. Shopify documents no allowance, so that number is a choice: change `leewaySeconds` if you want another.

## Rotating the client secret

Shopify says deliveries can take up to an hour to switch to a new secret. Every function in the file accepts a list of secrets, so pass both during the switch and drop the old one afterwards:

```typescript
const secrets = [process.env.SHOPIFY_CLIENT_SECRET!, process.env.SHOPIFY_CLIENT_SECRET_OLD].filter(Boolean) as string[];
```

## Common pitfalls

- **A JSON body parser runs before verification.** Every genuine webhook fails with 401, and Shopify keeps retrying it. Read raw bytes for the webhook route only.
- **Comparing signatures with `===`.** String comparison stops at the first different character, which leaks how much of a forged signature was right. The file uses `crypto.subtle.verify`, which compares in constant time.
- **Comparing hex to base64.** Webhooks use base64. The query `hmac` and app proxy `signature` use hex. The table at the top says which is which.
- **Decoding the body as the wrong text encoding.** Verify bytes, not a string you decoded and re-encoded.
- **Returning 200 for a failed check.** Return 401, so a misconfigured secret shows up in Shopify's delivery metrics instead of silently dropping data.
- **Treating a valid app proxy signature as authorization.** It only proves where the request came from.

## Related references

- [shopify-webhooks.md](shopify-webhooks.md): respond fast, drop duplicates, and ignore stale payloads
- [shopify-tokens.md](shopify-tokens.md): token exchange, refresh, and moving tokens out of Gadget
