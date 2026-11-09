# Callers outside the app

## What is this?

A Gadget app's API is public on the internet at `https://<app>.gadget.app/api/graphql`, and its HTTP routes are on the same domain. Anything can call it, and the callers that live outside the app's own code are the ones a move forgets:

| Caller | How it reaches Gadget | Why it is easy to miss |
|---|---|---|
| A separate frontend (Next.js, a marketing site, an admin tool) | The `@gadget-client/<app>` package | It lives in another repository |
| A mobile app | The client package or raw GraphQL | Old versions stay on phones for months after you ship a new one |
| A storefront theme | A `<script src="https://<app>.gadget.app/api/client/web.min.js">` tag, or `fetch` to a route | The code is in each store's theme, not in your repository |
| Another server, a script, or a cron job | An API key in an `Authorization: Bearer gsk-...` header | It runs on someone else's machine |
| Zapier, Make, n8n, or a spreadsheet | A saved URL and API key | A teammate set it up once |
| A third party's webhooks (Stripe, a shipping carrier, an ERP) | A URL on your `gadget.app` domain, saved in their dashboard | It only fires when something happens |

The inventory script can't see any of these, because none of them are in the pulled files. It lists the routes and roles they use. Finding the callers is manual.

## Find the callers

1. **List the API keys.** In the production environment, **Settings** > **API keys** shows every key and its role. Each key is at least one caller. Ask who holds each one.
2. **Read the roles.** A role in `accessControl/permissions.gadget.ts` that is not `signed-in`, `shopify-app-users`, or another role your frontend uses was made for an outside caller. Its grants are that caller's whole surface. Grants on the `unauthenticated` role are open to anyone, so check them too.
3. **List the routes.** Every file in `api/routes` is a URL something calls. Routes that accept `POST` and read a signature header are webhook receivers.
4. **Search the logs.** In the log viewer, search a week of production logs for each route's path and for the actions your own frontend never calls. A caller that only runs monthly needs a longer window, and Gadget keeps logs for 30 days by default.
5. **Search other repositories** for the app's domain and for `@gadget-client/`.

## What breaks, by kind of caller

**The generated client can't be pointed elsewhere.** `@gadget-client/<app>` and `@gadgetinc/react` speak Gadget's GraphQL API. Every call through them is rewritten against the new API. The package also installs from Gadget's registry (`@gadget-client:registry=https://registry.gadget.dev/npm` in `.npmrc`). Remove the dependency and that registry line from every project before you delete the Gadget app, so no build depends on the registry.

**Raw GraphQL callers send Gadget-shaped queries.** They expect connections with `edges`, `node`, and `pageInfo`, ids as strings, and action results shaped as `{ success, errors, <record> }` with error codes that start with `GGT_`. Do not rebuild Gadget's GraphQL API. List the operations each caller sends, then give each one an endpoint on the new API and change the caller.

**The URL changes unless you own the domain.** A `gadget.app` domain can't point at another host. If production already runs on a custom domain, you can move the domain, and callers of HTTP routes keep working when the new app serves the same paths. Callers of `/api/graphql` still break, because the new app does not answer Gadget's GraphQL.

**API keys do not carry over.** Issue new keys from the new app and hand them out. Do not copy the `gsk-` values across: they are Gadget credentials, and reusing them hides which system a caller is talking to.

**Browser callers on other origins need CORS.** Add each calling origin to the new API's allowed origins, and add the headers they send.

**Session cookies end.** A separate frontend that signed users in through Gadget's session loses those sessions, the same as the app's own frontend ([users-and-auth.md](users-and-auth.md)).

## Callers you can't update on the day

A mobile app released last year still calls Gadget next year. A theme edited by hand on 300 stores can't be changed in one deploy. For these, keep the Gadget app running as a thin layer in front of the new one until the old callers are gone:

```typescript
// in api/actions/createWidget.ts (the Gadget app, after the move)
export const run: ActionRun = async ({ params, logger }) => {
  const response = await fetch(`${process.env.NEW_API_URL}/widgets`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.NEW_API_KEY}` },
    body: JSON.stringify({ name: params.name }),
  });
  if (!response.ok) {
    logger.error({ status: response.status }, "forward to new API failed");
    throw new Error("Could not create widget");
  }
  return await response.json();
};

export const params = { name: { type: "string" } };
```

The old caller still talks to Gadget, in Gadget's shape, and the data lives in one place: the new database. This only works for global actions and HTTP routes, whose results you control. Reads that go straight to a model (`api.widget.findMany`) can't be forwarded, so callers that use them need a new release, or the model needs to be kept in step by a job until they are gone.

Watch the Gadget app's logs. When a week passes with no requests from the old callers, turn it off.

## Third-party webhooks

Each service that posts to a `gadget.app` URL has that URL saved in its own dashboard. For each one:

1. Add the new URL as a second endpoint in the service's dashboard, if it allows two. Most do, including Stripe.
2. Copy the signing secret for the new endpoint. A new endpoint usually gets a new secret, so the old one fails verification on the new app.
3. Make the handler safe to run twice ([background-jobs.md](background-jobs.md)), since both apps receive events for a while.
4. Remove the old endpoint after the switch.

These services sign the raw request body, so the new server needs the bytes as they arrived, before any JSON parsing. [shopify-signatures.md](shopify-signatures.md) shows how to get them on each framework, and the same approach works for any signed webhook.

## Issue and check API keys

Store a hash of each key, never the key, and compare in constant time:

```typescript
// in app/services/api-keys.server.ts
const encoder = new TextEncoder();

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Returns the key to show the caller once, and the hash to store.
export async function createApiKey(): Promise<{ key: string; hash: string }> {
  const key = `sk_${toHex(crypto.getRandomValues(new Uint8Array(24)))}`;
  return { key, hash: toHex(await sha256(key)) };
}

// `storedHashes` maps a stored hash to the role that key acts as. Returns the role, or null.
export async function roleForApiKey(authorization: string | null, storedHashes: Map<string, string>): Promise<string | null> {
  const key = /^Bearer (\S+)$/.exec(authorization ?? "")?.[1];
  if (!key) return null;
  const presented = await sha256(key);
  let role: string | null = null;
  for (const [hash, candidate] of storedHashes) {
    // compare every byte of every hash, so timing says nothing about how close a guess was
    let difference = hash.length === presented.length * 2 ? 0 : 1;
    for (let i = 0; i < presented.length; i++) difference |= presented[i] ^ parseInt(hash.slice(i * 2, i * 2 + 2), 16);
    if (difference === 0) role = candidate;
  }
  return role;
}
```

With more than a few dozen keys, look the hash up in an indexed column instead of looping. A SHA-256 of a random 24-byte key can't be guessed, so the lookup is safe.

Each Gadget key acted as a role. Give each new key the smallest set of permissions its caller used, which is that role's grants in `accessControl/permissions.gadget.ts`.

## Common pitfalls

- **Finding callers by reading only your own code.** The ones that break are elsewhere. Read the API keys and the logs.
- **Deleting the Gadget app while a build still installs `@gadget-client`.** Remove the dependency first.
- **Assuming a custom domain keeps GraphQL callers working.** It keeps routes working. The GraphQL API does not move.
- **Reusing a webhook signing secret on a new endpoint.** The service issued a new one.
- **Rebuilding Gadget's GraphQL schema.** It is weeks of work to serve a handful of operations. Write the handful.

## Related references

- [actions-and-transactions.md](actions-and-transactions.md): HTTP routes on the new server
- [non-shopify-apps.md](non-shopify-apps.md): cutover when nothing switches traffic for you
- [cutover.md](cutover.md): the order of the Shopify cutover, which these callers fit around
