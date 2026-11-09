# Shopify access tokens

## What is this?

Stores keep the app installed when it moves, so the new app can use their existing offline tokens instead of waiting for each merchant to open it. Gadget held those tokens on the `shopifyShop` model and refreshed them for you. The new app has to hold them, refresh them, and take them over from Gadget without the two apps breaking each other's tokens.

## How expiring offline tokens work

Gadget requests expiring offline tokens for apps on Shopify API version 2026-04 and later:

- An access token lasts 1 hour (`expires_in: 3600`).
- Each refresh returns a new access token and a new refresh token. A refresh token lasts 90 days when issued.
- Shopify keeps one current token per app and store. A refresh retires the previous tokens, and a token exchange (how an embedded app gets a token when a merchant opens it) retires every other refresh token for the store at once.
- A retired access token keeps working until it expires. A retired refresh token gets `401` with `This request requires an active refresh_token`, which is final: the app can't call Shopify for that store until the merchant opens it again.

Shopify blocks public apps that still use non-expiring tokens from new installs, and removes them from the App Store, from 1 January 2027. Existing installs keep working until 1 April 2027, when those tokens start getting `403`.

## Why moving tokens breaks apps

Gadget gets new tokens for a store in four ways while its environment is active:

1. When it calls Shopify in a token's last 2 minutes, for your code, a webhook, or a sync.
2. When Shopify rejects a token with `401`.
3. Once a day before its reconciliation.
4. When a request signed with the store's session token reaches it, from the Gadget frontend or an extension that still calls Gadget. With no refresh token stored, this runs a token exchange.

Clearing Gadget's refresh token stops the first three. Only routing every request away from Gadget stops the fourth. Here is what skipping that does: the new app saves a store's tokens at 10:00. At 10:20 the merchant uses an admin extension that still calls Gadget, and Gadget runs a token exchange, retiring the new app's refresh token. The new app's access token works until 11:00, its refresh at 10:55 fails with the final `401`, and from 11:00 it can't call Shopify for that store.

## The handoff, in order

1. Release extensions that point at the new app, and switch webhooks and app URLs with `shopify app deploy` ([cutover.md](cutover.md)). Nothing reaches Gadget for the store after this.
2. For each store, skip it if the new app already has an offline session. A merchant who opened the new app after the switch gave it fresh tokens through token exchange, and those retired Gadget's.
3. Read the store's tokens from Gadget's Internal API.
4. Save them in the new app.
5. Clear `refreshToken` on Gadget's `shopifyShop` record.
6. From then on, the new app refreshes every store before its refresh token expires, including quiet stores.

This script does steps 2 to 5 for an app on Shopify's React Router template, which stores sessions with Prisma. It needs a Gadget API key with **Access control** turned off, created in the production environment, and the app's generated client package:

```typescript
// in scripts/move-shopify-tokens.ts
import { Client } from "@gadget-client/my-app";
import { PrismaClient } from "@prisma/client";

const gadget = new Client({ environment: "Production", authenticationMode: { apiKey: process.env.GADGET_EXPORT_API_KEY! } });
const prisma = new PrismaClient();

let cursor: string | undefined;
do {
  const shops = await gadget.internal.shopifyShop.findMany({ first: 50, after: cursor, filter: { state: { inState: "created.installed" } } });
  for (const shop of shops) {
    const sessionId = `offline_${shop.myshopifyDomain}`; // the template's offline session id
    if (await prisma.session.findUnique({ where: { id: sessionId } })) {
      console.log(`skip ${shop.myshopifyDomain}: the new app already has a session`);
      continue;
    }
    await prisma.session.create({
      data: {
        id: sessionId,
        shop: shop.myshopifyDomain,
        state: "",
        isOnline: false,
        scope: shop.grantedScopes?.join(",") ?? null,
        accessToken: shop.accessToken,
        expires: shop.accessTokenExpiresAt ?? null,
        refreshToken: shop.refreshToken ?? null,
        refreshTokenExpires: shop.refreshTokenExpiresAt ?? null,
      },
    });
    if (shop.refreshToken) await gadget.internal.shopifyShop.update(shop.id, { refreshToken: null });
    console.log(`moved ${shop.myshopifyDomain}`);
  }
  cursor = shops.hasNextPage ? shops.endCursor : undefined;
} while (cursor);
```

Run it once on a development store first and check that the new app can call Shopify for that store. Check the field names against your app's generated client before running it on production. `grantedScopes` is an array on Gadget and a comma-separated string in the template's session.

## Refreshing tokens in the new app

Shopify's React Router template refreshes expiring offline tokens when `future.expiringOfflineAccessTokens` is `true` in `shopify.server.ts`, which is the template's default. It refreshes 5 minutes before expiry.

Apps on another framework refresh with one request:

```typescript
// in app/shopify/refreshToken.server.ts
export async function refreshOfflineToken(shop: string, refreshToken: string) {
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.SHOPIFY_CLIENT_ID!,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET!,
      refresh_token: refreshToken,
    }),
  });
  if (response.status === 401) throw new ReauthorizationRequired(shop); // final: wait for the merchant to open the app
  if (!response.ok) throw new Error(`refresh failed with ${response.status}`); // 429, 5xx: retry with the same refresh token
  const body = (await response.json()) as { access_token: string; expires_in: number; refresh_token: string; refresh_token_expires_in?: number };
  return {
    accessToken: body.access_token,
    expiresAt: new Date(Date.now() + body.expires_in * 1000),
    refreshToken: body.refresh_token,
    refreshTokenExpiresAt: body.refresh_token_expires_in ? new Date(Date.now() + body.refresh_token_expires_in * 1000) : null,
  };
}

export class ReauthorizationRequired extends Error {}
```

Three rules keep it working:

- **One refresh per store at a time.** Two workers refreshing the same store leave one of them holding a retired token. Take a lock per store, such as `pg_advisory_xact_lock(hashtextextended('shopify-refresh:' || shop, 0))`, then re-read the stored token: another worker may have refreshed it while you waited.
- **Save both tokens before using either.** The next refresh needs the new refresh token.
- **Refresh quiet stores.** A store with no traffic for 90 days loses its refresh token. Run a daily job that refreshes any store whose refresh token expires within a week.

## Non-expiring tokens

Stores whose tokens Gadget got on a Shopify API version before 2026-04 have tokens that don't expire, so both apps can use them during the move. On API version 2026-04 and later, Gadget can replace such a token with an expiring one, for example when a merchant opens the Gadget app, and Shopify then invalidates the old token in both apps. Move them in the same order as expiring tokens.

## Common pitfalls

- **Moving tokens before switching URLs and extensions.** Any request that reaches Gadget can run a token exchange and retire the new app's tokens.
- **Overwriting a fresh session with Gadget's tokens.** If the merchant opened the new app after the switch, Gadget's tokens are already retired.
- **Uninstalling the store from the Gadget editor.** That removes the app from the store, and the new app is the same Shopify app.
- **Deploying the Gadget app after the switch.** On framework 1.7 and later, an editor deploy runs `shopify app deploy` with Gadget's TOML, which points webhooks and app URLs back at Gadget.
- **Calling Shopify from a host that isn't on the app's IP allowlist.** Every call fails with `403`.
- **Treating a refresh `401` as transient.** Retrying a retired refresh token never works. Mark the store and wait for the merchant.

## Related references

- [cutover.md](cutover.md): where the handoff fits in the move
- [shopify-signatures.md](shopify-signatures.md): verifying the session tokens the new app receives
