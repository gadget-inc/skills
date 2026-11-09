# Shopify access tokens

## What is this?

Stores keep the app installed when it moves, so the new app can call Shopify for them without waiting for each merchant to open it. Gadget held each store's offline token on the `shopifyShop` model and refreshed it for you. The new app has to get its own way to call each store, and it has to do that without the two apps breaking each other's tokens.

There are two ways to do it:

- **Move each store's tokens** from Gadget to the new app. This is what the Shopify app template expects, and most of this file is about doing it in a safe order.
- **Use application-only access tokens** for background work, which need no handoff at all. See [Skip the handoff](#skip-the-handoff-with-application-only-access-tokens).

## How expiring offline tokens work

Gadget requests expiring offline tokens for apps on Shopify API version 2026-04 and later. Shopify's rules for them:

- An access token lasts 1 hour (`expires_in: 3600`). Read `expires_in` instead of assuming it.
- Each refresh returns a new access token and a new refresh token. A refresh token lasts 90 days when issued.
- The refresh token you presented is not retired at once. It stays usable until the app uses the newer one, or a token exchange happens, or 30 days pass since its first use, or it reaches its 90-day expiry. So a refresh whose response was lost can be repeated with the same token.
- A token exchange, which is how an embedded app gets a token when a merchant opens it, retires every other refresh token for the store at once.
- A replaced access token keeps working until its own hour ends.
- A refresh token that can't be used gets `401` with `{"error": "invalid_request"}` and the description `This request requires an active refresh_token`. That is final: the app can't call Shopify for that store until the merchant opens it again.

Shopify blocks public apps that still use non-expiring tokens from new installs, and removes them from the App Store, from 1 January 2027. Existing installs keep working until 1 April 2027, when Admin API requests with those tokens start getting `403`.

## Why moving tokens breaks apps

Gadget gets new tokens for a store in five ways while its environment is active:

1. When it calls Shopify in a token's last 2 minutes, for your code, a webhook, or a sync.
2. When Shopify rejects a token with `401`.
3. Once a day before its reconciliation, for every installed store that has a refresh token.
4. When a request signed with the store's session token reaches it, from the Gadget frontend or an extension that still calls Gadget. If any of the store's four token fields is empty, this runs a token exchange.
5. On API version 2026-04 and later, a background job that checks every hour for stores still on a non-expiring token and exchanges each one for an expiring pair. No merchant is involved, and Shopify revokes the old token the moment the exchange succeeds.

Clearing Gadget's refresh token stops the first three. Only routing every request away from Gadget stops the fourth. The fifth only touches stores with a non-expiring token, and clearing a refresh token does nothing for those, because they have none.

Here is what skipping the routing does: the new app saves a store's tokens at 10:00. At 10:20 the merchant uses an admin extension that still calls Gadget, and Gadget runs a token exchange, retiring the new app's refresh token. The new app's access token works until 11:00, its refresh at 10:55 fails with the final `401`, and from 11:00 it can't call Shopify for that store.

Here is what copying a non-expiring token does on 2026-04 or later: the new app saves the token at 10:00. Within the hour Gadget's background job exchanges the same token, Shopify revokes it, and the new app's copy stops working with no refresh token to recover with. So the new app exchanges a non-expiring token itself instead of copying it.

## The handoff, in order

1. Release extensions that point at the new app, and switch webhooks and app URLs with `shopify app deploy` ([cutover.md](cutover.md)). Nothing reaches Gadget for the store after this.
2. Let Gadget's background actions that call Shopify finish. Once a store's tokens move, Gadget's access token for it works for at most 1 more hour.
3. For each store, skip it if the new app already has an offline session. A merchant who opened the new app after the switch gave it fresh tokens through token exchange, and those retired Gadget's.
4. Read the store's tokens from Gadget's Internal API.
5. If the store has a refresh token, save both tokens in the new app, then clear `refreshToken` on Gadget's `shopifyShop` record. If Gadget refreshed between your read and your clear, the pair you saved still works, because Gadget never used its newer refresh token.
6. If the store has a non-expiring token, exchange it for an expiring pair and save that. The exchange revokes Gadget's copy at once. On apps below API version 2026-04, set Gadget's off switch first ([cutover.md](cutover.md) steps 4 and 7), because Gadget's next sync runs the store's `uninstall` action when it finds the token revoked.
7. From then on, the new app refreshes every store before its refresh token expires, including quiet stores.

These two functions do the refresh and the exchange with one request each:

```typescript
// in app/shopify/tokens.server.ts
export class ReauthorizationRequired extends Error {}

async function requestTokens(shop: string, grant: Record<string, string>) {
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: process.env.SHOPIFY_API_KEY!,
      client_secret: process.env.SHOPIFY_API_SECRET!,
      ...grant,
    }),
  });
  // final: only the merchant opening the app, or an application-only token, gets the store back
  if (response.status === 401) throw new ReauthorizationRequired(shop);
  // 429 and 5xx are safe to retry with the same token. 400 and 403 fail the same way every time
  if (!response.ok) throw new Error(`token request for ${shop} failed with ${response.status}`);
  const body = (await response.json()) as { access_token: string; scope: string; expires_in: number; refresh_token: string; refresh_token_expires_in: number };
  if (!body.refresh_token || !body.expires_in) throw new Error(`token response for ${shop} has no refresh token`);
  return {
    accessToken: body.access_token,
    scope: body.scope,
    expiresAt: new Date(Date.now() + body.expires_in * 1000),
    refreshToken: body.refresh_token,
    refreshTokenExpiresAt: new Date(Date.now() + body.refresh_token_expires_in * 1000),
  };
}

export function refreshOfflineToken(shop: string, refreshToken: string) {
  return requestTokens(shop, { grant_type: "refresh_token", refresh_token: refreshToken });
}

// Shopify revokes the non-expiring token when this succeeds. If the response is lost, the same
// request with the same token returns the same pair for 7 days, until the pair is first refreshed.
export function exchangeNonExpiringToken(shop: string, nonExpiringToken: string) {
  return requestTokens(shop, {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: nonExpiringToken,
    subject_token_type: "urn:shopify:params:oauth:token-type:offline-access-token",
    requested_token_type: "urn:shopify:params:oauth:token-type:offline-access-token",
    expiring: "1",
  });
}
```

This script does steps 3 to 6 for an app on Shopify's React Router template, which stores sessions with Prisma. It needs a Gadget API key with **Access control** turned off, created in the production environment, the app's generated client package, and the Shopify app's client id and secret:

```typescript
// in scripts/move-shopify-tokens.ts
import { Client } from "@gadget-client/my-app";
import { PrismaClient } from "@prisma/client";
import { exchangeNonExpiringToken } from "../app/shopify/tokens.server";

const gadget = new Client({ environment: "Production", authenticationMode: { apiKey: process.env.GADGET_EXPORT_API_KEY! } });
const prisma = new PrismaClient();

let cursor: string | undefined;
do {
  const shops = await gadget.internal.shopifyShop.findMany({ first: 50, after: cursor, filter: { state: { inState: "created.installed" } } });
  for (const shop of shops) {
    const domain = shop.myshopifyDomain;
    const sessionId = `offline_${domain}`; // the template's offline session id
    if (await prisma.session.findUnique({ where: { id: sessionId } })) {
      console.log(`skip ${domain}: the new app already has a session`);
      continue;
    }

    let tokens;
    if (shop.refreshToken) {
      tokens = { accessToken: shop.accessToken, expiresAt: shop.accessTokenExpiresAt, refreshToken: shop.refreshToken, refreshTokenExpiresAt: shop.refreshTokenExpiresAt };
    } else if (shop.accessTokenExpiresAt) {
      console.log(`skip ${domain}: Shopify already rejected its refresh token, so it needs the merchant to open the app`);
      continue;
    } else {
      tokens = await exchangeNonExpiringToken(domain, shop.accessToken);
    }

    await prisma.session.create({
      data: {
        id: sessionId,
        shop: domain,
        state: "",
        isOnline: false,
        scope: shop.grantedScopes?.join(",") ?? null,
        accessToken: tokens.accessToken,
        expires: tokens.expiresAt,
        refreshToken: tokens.refreshToken,
        refreshTokenExpires: tokens.refreshTokenExpiresAt,
      },
    });
    if (shop.refreshToken) await gadget.internal.shopifyShop.update(shop.id, { refreshToken: null });
    console.log(`moved ${domain}`);
  }
  cursor = shops.hasNextPage ? shops.endCursor : undefined;
} while (cursor);
```

Run it on a development store first. Then, from the new host, run one Admin API query for that store through `unauthenticated.admin(shop)`. Run that check from the host and not from your laptop: Shopify's IP allowlist applies to Admin API requests, though not to the token requests the script makes. If the script stops partway, run it again. Stores it finished are skipped, and a repeated exchange returns the same pair.

Things to know before running it on production:

- **Field names.** Apps on a Shopify API version before 2026-04 have no `refreshToken`, `accessTokenExpiresAt`, or `refreshTokenExpiresAt` fields, so every store takes the exchange branch. `grantedScopes` is an array on Gadget and a comma-separated string in the template's session.
- **The exchange ends Gadget's access to the store.** That is the point, but on an app below 2026-04, Gadget reacts to the `401` its next sync gets by running the store's `shopifyShop` `uninstall` action. Before the switch, make that action do nothing unless its trigger is the `app/uninstalled` webhook. See [cutover.md](cutover.md).
- **Don't copy a non-expiring token to save the exchange.** The template would use it and never upgrade it, which misses the 1 January 2027 deadline, and on 2026-04 or later Gadget's background job revokes it within the hour.

## Skip the handoff with application-only access tokens

Shopify lets an app with public distribution get an access token for any store that has it installed, with no merchant session and no stored token. The app signs a short JWT, called a client assertion, with a private key, and Shopify checks it against a public key you add under **Settings** > **Credentials** > **Public keys** in the Dev Dashboard. The token lasts up to 1 hour, comes with no refresh token, and getting one doesn't retire the offline tokens Gadget holds. So the new app's background jobs can call Shopify from the first minute, and nothing Gadget does can cut them off. Custom apps can only use this for stores in their own organization.

Generate the key with `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out private.pem`, add its public half as a JWK with a `kid`, and request a token:

```typescript
// in app/shopify/appOnlyToken.server.ts
const base64url = (input: string | ArrayBuffer) => {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export async function appOnlyToken(shop: string) {
  // the audience must be the store's lowercase permanent domain
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) throw new Error(`not a myshopify.com domain: ${shop}`);
  const endpoint = `https://${shop}/admin/oauth/access_token`;
  const clientId = process.env.SHOPIFY_API_KEY!;

  const pem = process.env.SHOPIFY_PRIVATE_KEY!; // the contents of private.pem
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, "")), (char) => char.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);

  // one assertion per request: Shopify accepts each jti once, so sign a new one for every retry
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid: process.env.SHOPIFY_KEY_ID! };
  const claims = { iss: clientId, sub: clientId, aud: endpoint, iat: now, exp: now + 60, jti: crypto.randomUUID() };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    // no client secret: Shopify rejects a request that authenticates two ways
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: `${unsigned}.${base64url(signature)}`,
    }),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`application-only token request for ${shop} failed with ${response.status}`);
  const body = (await response.json()) as { access_token: string; scope: string; expires_in: number };
  return { accessToken: body.access_token, scope: body.scope, expiresAt: new Date(Date.now() + body.expires_in * 1000) };
}
```

Cache the token per store and get a new one a few minutes before it expires. Send it in the `X-Shopify-Access-Token` header like any other token. `@shopify/shopify-api` 15.1 and later has the same two steps as `auth.createClientAssertion` and `auth.clientCredentials`. The template's `unauthenticated.admin` doesn't use them: it reads the stored offline session, so jobs on these tokens build their own client.

The assertion's claims and the request above follow Shopify's documentation and were checked against a locally generated key. They weren't run against Shopify.

## Refreshing tokens in the new app

Shopify's React Router template refreshes expiring offline tokens when `future.expiringOfflineAccessTokens` is `true` in `shopify.server.ts`, which is the template's default. What it does, checked by running the library:

- `unauthenticated.admin(shop)`, `authenticate.webhook`, and `authenticate.public.appProxy` refresh the stored token when it has less than 5 minutes left, and save both new tokens.
- `authenticate.admin` doesn't refresh. When a merchant opens the app and the stored token has less than 5 minutes left, it runs a token exchange, which retires every other refresh token for the store.
- When a refresh fails for any reason, including the final `401`, the library throws a `Response` with status 500. For `authenticate.webhook`, that means every webhook for a store with a dead refresh token is answered with 500, although its HMAC is valid. Shopify retries each one 8 times and then drops it.
- The library takes no lock. Two requests in the same 5 minutes both refresh.
- A stored token with no expiry is used as it is. The library never exchanges it for an expiring one.

Apps on another framework call `refreshOfflineToken` from the block above. Three rules keep it working:

- **One refresh per store at a time.** Two workers refreshing the same store can leave one of them holding a token the other has replaced. Take a lock per store, such as `pg_advisory_xact_lock(hashtextextended('shopify-refresh:' || shop, 0))`, then re-read the stored token: another worker may have refreshed it while you waited.
- **Save both tokens before using either.** The next refresh needs the new refresh token.
- **Refresh quiet stores.** A store with no traffic for 90 days loses its refresh token. Run a daily job that refreshes any store whose refresh token expires within a week.

## Common pitfalls

- **Moving tokens before switching URLs and extensions.** Any session token request that reaches Gadget can run a token exchange and retire the new app's tokens.
- **Overwriting a fresh session with Gadget's tokens.** If the merchant opened the new app after the switch, Gadget's tokens are already retired.
- **Copying a non-expiring token.** Gadget's background job or the 2027 deadline ends it. Exchange it.
- **Leaving Gadget's `uninstall` action armed.** On an app below 2026-04, Gadget runs it for every store whose token the new app replaced.
- **Uninstalling the store from the Gadget editor.** That removes the app from the store, and the new app is the same Shopify app.
- **Deploying the Gadget app from the editor after the switch.** On framework 1.7 and later, an editor deploy runs `shopify app deploy` with Gadget's TOML, which points webhooks and app URLs back at Gadget.
- **Calling the Admin API from a host that isn't on the app's IP allowlist.** Every call fails with `403`.
- **Treating a refresh `401` as transient.** Retrying a retired refresh token never works. Mark the store and wait for the merchant, or use an application-only token.

## Related references

- [cutover.md](cutover.md): where the handoff fits in the move
- [shopify-signatures.md](shopify-signatures.md): verifying the session tokens the new app receives
- [shopify-webhooks.md](shopify-webhooks.md): what a dead token does to webhook intake
