# Moving a BigCommerce app

## What is this?

Gadget's BigCommerce connection builds single-click apps. It handled the OAuth install, verified the load callback, registered webhooks for each store, ran your global actions for them with retries, and gave your code an API client for each store. It did not sync BigCommerce data: every `bigcommerce/*` model besides `bigcommerce/store` is one you wrote and filled yourself.

That makes this move smaller than a Shopify one. There is no data sync to rebuild and no token rotation to race. What needs rebuilding is the three callbacks, webhook delivery, and store scoping. The inventory script flags `bigcommerce` in `settings.gadget.ts`. Skip the Shopify references and use this file with the general ones.

| Gadget did this | What replaces it |
|---|---|
| Auth callback: exchanged the code for an access token and created the `bigcommerce/store` record | A `GET` route that posts to BigCommerce's token endpoint |
| Load callback: verified `signed_payload_jwt` and started a session | A `GET` route that verifies the token and sets your own session cookie |
| `Provider` from `@gadgetinc/react-bigcommerce` | Your session, read by your loaders or API routes |
| Registered a webhook per store for each scope in your action triggers | Calls to `/v3/hooks` for each store |
| Ran webhook-triggered global actions as background actions with retries | A route that answers `200` at once and queues a job |
| `connections.bigcommerce.current` and `forStoreHash` | A small client built from the store's hash and token |
| `preventCrossStoreDataAccess` and the `bigcommerce-app-users` role | A store condition on every query |

## Tokens move without a race

A BigCommerce access token does not rotate or expire on a timer. Both apps can call the API with the same token during the move. BigCommerce replaces a store's token only when you change the app's OAuth scopes or the store owner's email changes. Then the merchant accepts the change the next time they open the app, and the app receives a new auth callback.

Export `bigcommerce/store` with the Internal API ([data-export.md](data-export.md)). Each record has the `storeHash` and the `accessToken`. Keep the same client id and client secret in the new app: it is the same app in BigCommerce's Developer Portal, pointed at new callback URLs.

Do not change scopes during the move. A scope change makes BigCommerce send a fresh auth callback to whichever app the callback URL points at, and the other app's copy of the token stops working.

## Callbacks

The app profile in the Developer Portal has four callback URLs: auth, load, uninstall, and remove user. All four point at the Gadget app today.

The auth callback receives `code`, `scope`, and `context` (`stores/<hash>`) in the query string. Exchange them:

```typescript
// in app/routes/bigcommerce.auth.ts
export async function exchangeCode(query: URLSearchParams) {
  const response = await fetch("https://login.bigcommerce.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.BIGCOMMERCE_CLIENT_ID,
      client_secret: process.env.BIGCOMMERCE_CLIENT_SECRET,
      code: query.get("code"),
      scope: query.get("scope"),
      context: query.get("context"),
      grant_type: "authorization_code",
      redirect_uri: process.env.BIGCOMMERCE_AUTH_CALLBACK_URL, // must match the app profile exactly
    }),
  });
  if (!response.ok) throw new Error(`token exchange failed: ${response.status}`);
  // { access_token, scope, user, owner, context: "stores/<hash>", account_uuid }
  return response.json();
}
```

Upsert the store on its hash. A reinstall sends a new auth callback for a hash you already have.

The load, uninstall, and remove-user callbacks carry a `signed_payload_jwt` query parameter, signed with the app's client secret. [`assets/bigcommerce-signed-payload.ts`](../assets/bigcommerce-signed-payload.ts) verifies it with Web Crypto only:

```typescript
// in app/routes/bigcommerce.load.ts
import { verifyBigCommerceSignedPayload } from "../lib/bigcommerce-signed-payload";

const payload = await verifyBigCommerceSignedPayload(
  new URL(request.url).searchParams.get("signed_payload_jwt"),
  process.env.BIGCOMMERCE_CLIENT_ID!,
  process.env.BIGCOMMERCE_CLIENT_SECRET!
);
if (!payload) return new Response(null, { status: 401 });
// payload.storeHash, payload.user.id, payload.user.email, payload.owner.id
```

### ❌ Decoding without verifying

```typescript
const payload = JSON.parse(atob(token.split(".")[1])); // anyone can write "sub": "stores/<any hash>"
```

The middle part of a token is plain base64. Without the signature check, a visitor who knows a store's hash opens that store's data.

After a verified load, set your own session cookie. The app runs in an iframe inside the BigCommerce control panel, so the cookie needs `SameSite=None; Secure`, and some browsers block third-party cookies anyway. A signed token in the URL or in a request header, which your frontend sends on each call, avoids the problem.

The token is valid for 24 hours, so a copied load URL keeps working that long. Record each `jti` you accept if a replayed load would do harm.

## Webhooks

BigCommerce webhooks differ from Shopify's in four ways that change the design:

- **They are registered per store through the API.** Nothing like `shopify.app.toml` switches them all in one deploy.
- **They are not signed.** BigCommerce sends whatever custom `headers` you registered with the webhook. Register a long random secret as a header and compare it on every delivery.
- **The payload is ids only**, such as `{ "scope": "store/order/updated", "store_id": "1025646", "data": { "type": "order", "id": 250 }, "hash": "..." }`. The handler fetches the record from the API, so it always reads current data and stale payloads are not a concern.
- **A failing destination gets switched off.** BigCommerce retries on a schedule that ends 48 hours after the first attempt, then deactivates the webhook and emails the app's registered address. A subscription with no activity for 90 days is deactivated too. Nothing turns it back on for you.

Answer `200` right away and do the work in a job, as with Shopify ([shopify-webhooks.md](shopify-webhooks.md) has the queue pattern). Use the payload's `hash` as the job's deduplication key, because BigCommerce can deliver the same event twice.

A store can have the same scope registered for two destinations, so both apps can receive webhooks during the move. Register the new app's webhooks first, with each store's token:

```typescript
// in scripts/register-bigcommerce-webhooks.ts
const SCOPES = ["store/order/created", "store/order/updated"]; // the scopes from your Gadget action triggers

export async function registerWebhooks(storeHash: string, accessToken: string, destination: string, secret: string) {
  const base = `https://api.bigcommerce.com/stores/${storeHash}/v3/hooks`;
  const headers = { "X-Auth-Token": accessToken, "Content-Type": "application/json", Accept: "application/json" };

  const existing = await (await fetch(base, { headers })).json();
  const have = new Set(existing.data.filter((hook: any) => hook.destination === destination).map((hook: any) => hook.scope));

  for (const scope of SCOPES) {
    if (have.has(scope)) continue;
    const response = await fetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify({ scope, destination, is_active: true, headers: { "X-Webhook-Secret": secret } }),
    });
    if (!response.ok) throw new Error(`could not register ${scope} for ${storeHash}: ${response.status}`);
  }
}
```

A new webhook can take up to a minute to start delivering. The destination must be HTTPS on port 443.

Add a daily job that lists each store's webhooks and sets `is_active` back to `true` on any that BigCommerce switched off, then fetches what changed in the gap. Gadget's install page showed webhook status, and nothing shows it now.

## Calling the API

```typescript
// in app/services/bigcommerce.server.ts
export function bigcommerceClient(storeHash: string, accessToken: string) {
  return async function request(path: string, init: RequestInit = {}) {
    const response = await fetch(`https://api.bigcommerce.com/stores/${storeHash}${path}`, {
      ...init,
      headers: { "X-Auth-Token": accessToken, "Content-Type": "application/json", Accept: "application/json", ...init.headers },
    });
    if (response.status === 429) {
      // BigCommerce says how long to wait
      const waitMs = Number(response.headers.get("X-Rate-Limit-Time-Reset-Ms") ?? 1000);
      throw Object.assign(new Error("rate limited"), { retryAfterMs: waitMs });
    }
    if (!response.ok) throw new Error(`BigCommerce ${init.method ?? "GET"} ${path}: ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
}
```

Background actions with a named queue paced your calls per store on Gadget. Keep a concurrency limit per store hash in the new queue ([background-jobs.md](background-jobs.md)).

## Store scoping

Records in your `bigcommerce/*` models belong to a store through a relationship to `bigcommerce/store`. The `bigcommerce-app-users` role and `preventCrossStoreDataAccess` kept one store from reading another's. [shop-tenancy.md](shop-tenancy.md) applies as written, with the store's id in place of the shop's id. Take the store from the verified load payload or your session, never from a request parameter.

Models in the `bigcommerce` namespace live in `api/models/bigcommerce/<model>/` and are called as `api.bigcommerce.<model>`. Name the tables `bigcommerce_<model>`.

## Cutover order

1. Deploy the new app with the same client id and secret, load the exported stores and custom models, and move each id sequence with the gap from [schema-mapping.md](schema-mapping.md#move-sequences-after-loading). The new app writes records from step 2 on, and Gadget's records from the catch-up need ids below them.
2. Register the new app's webhooks for every store. Both apps now receive every event, so make sure the new app's writes to BigCommerce and its emails are off, or the Gadget app's are.
3. Stop writes in Gadget, turn off its scheduled actions, let its queue drain, and run the catch-up export from [data-export.md](data-export.md#catch-up-on-records-that-change-during-the-export) and load it, as in steps 1 to 3 of the "Cutover without Shopify" section of [non-shopify-apps.md](non-shopify-apps.md#cutover-without-shopify). Without this step, every record Gadget wrote after the first export stays behind. Turn on the new app's cron jobs after the load.
4. Change the four callback URLs in the Developer Portal. Merchants who open the app now load the new one.
5. Remove the webhook triggers from the Gadget app's actions and deploy it. Gadget unregisters webhooks that no longer have a trigger. Then list each store's webhooks and delete any that still point at the Gadget URL.
6. Keep the Gadget app until the records match.

Do not uninstall the app from a store to clean up. BigCommerce deletes that store's webhooks for both apps, and the merchant has to install again.

## Common pitfalls

- **Changing scopes mid-move.** Every store's token is replaced on the next load, and the app that did not receive the auth callback is locked out.
- **Treating the webhook secret header as optional.** Without it, anyone who finds the URL can post fake events. The payload has no signature to fall back on.
- **Trusting the webhook payload's ids without the store.** Look the store up by `producer` (`stores/<hash>`) and fetch the record with that store's token.
- **No job to reactivate webhooks.** One bad deploy that fails for 48 hours leaves every store's webhooks off.
- **A cookie-only session in the iframe.** Browsers that block third-party cookies load a blank or logged-out app.

## Related references

- [data-export.md](data-export.md): exporting `bigcommerce/store` and your own models
- [shop-tenancy.md](shop-tenancy.md): scoping queries to one store
- [background-jobs.md](background-jobs.md): queues with a limit per store
