# Cutting over

## What is this?

The cutover is the hour where Shopify stops talking to Gadget and starts talking to the new app. Most failures come from doing the right steps in the wrong order: tokens moved while Gadget still receives requests, a backfill from a host Shopify rejects, or a Gadget deploy that quietly points everything back. Build and test the new app against a development store first, then follow this order for production.

## Before the day

Each of these has broken a cutover that got the order right:

- **Use the same Shopify app.** The new app runs with the `client_id` and client secret of the app merchants already installed. Run `shopify app config link` in the new project and pick that app. A new Shopify app has no installs, and every merchant would have to install again.
- **Copy the whole `extensions` folder into the new project** before its first `shopify app deploy`, each extension with its `shopify.extension.toml`. That includes the ones that never call Gadget: Shopify Functions, theme app extensions with no fetch, and web pixels. A deploy releases only the extensions in the project it runs from, and the new version replaces the old one on every store, so a discount Function left behind stops applying at checkout. The CLI lists the extensions it will remove and asks before it releases, so read that list. Never pass `--allow-deletes` on this deploy: it removes them without asking. The inventory lists every extension with its type.
- **Rehearse on a development store with a separate Shopify app.** Install the new code there, send it real webhooks, and run the token script from [shopify-tokens.md](shopify-tokens.md) against it once.
- **Set production environment variables on the new host**, including the values Gadget supplied (`GADGET_APP_URL` and the rest in [frontend.md](frontend.md)). `ggt var get` can't read secret values, so collect those from the services that issued them. `ggt var list --app my-app --env production` prints the name of every variable, secrets included, so compare its output with the names set on the new host. A variable that is missing rarely fails loudly: a Slack notification whose webhook URL isn't set just stops arriving.
- **Use Gadget's Shopify API version.** Set the template's `apiVersion` in `app/shopify.server.ts`, and `api_version` under `[webhooks]` in `shopify.app.toml`, to the version the inventory reports. Shopify renames and removes fields between versions, so a version change during the move breaks queries and webhook handlers that were never touched. Upgrade afterwards, as its own change.
- **Run database migrations and time a full import.** The catch-up export in [data-export.md](data-export.md) only works if you noted when the first export started.
- **List everything outside Shopify that calls the Gadget app.** Webhooks from other services (payment, email, shipping, ERP) point at `https://my-app.gadget.app/...` routes and are signed with secrets you need on the new host. OAuth clients for other services list Gadget redirect URLs. Scripts, storefront themes, and other apps may call the Gadget API with an API key. Each one needs its URL changed at the switch, and Shopify's deploy changes none of them.
- **Verify the email sending domain** with the new provider. Gadget's built-in email sends from `noreply@my-app.gadget.app` unless your code set a `from` on your own domain, and that address stops working for you.
- **Lower the DNS TTL** a day ahead if a custom domain moves, so the change takes minutes, not hours.
- **Tell users of a web app** that they will sign in again ([users-and-auth.md](users-and-auth.md)).

## The order

1. **Allow the new host to call Shopify.** See [The IP allowlist](#the-ip-allowlist) below. Do this before the new host makes one call.
2. **Backfill Shopify data** for every store ([shopify-sync.md](shopify-sync.md)). Until step 8, the new app has sessions only for stores whose merchant opened it after step 6, and `unauthenticated.admin` throws `SessionNotFoundError` for the rest. So the backfill, and every job that calls Shopify before step 8, uses an [application-only token](shopify-tokens.md#skip-the-handoff-with-application-only-access-tokens) or Gadget's current `accessToken` from the Internal API, never saved as a session. Gadget refreshes only in [five cases](shopify-tokens.md#why-moving-tokens-breaks-apps), so a quiet store's token can have expired hours ago. When `accessTokenExpiresAt` is near or past, or Shopify answers `401`, call a Gadget global action, deployed before this step, that sends one query through `connections.shopify.forShopId`, then read the token again. Don't copy the refresh token: that is step 8.
3. **Load custom models** and move each id sequence ([data-export.md](data-export.md), [schema-mapping.md](schema-mapping.md)). This includes the fields you added to Shopify models, which a backfill from Shopify can't restore.
4. **Move scheduled work.** Turn off the scheduler triggers in the Gadget app, including `scheduledShopifySync`, deploy that change, and turn on the new cron jobs once those that call Shopify get a token as in step 2. Recreate background actions with a future `startAt` in the new queue and cancel them in Gadget's **Queues** dashboard ([background-jobs.md](background-jobs.md)). In the same Gadget deploy, put the side effects Gadget could still run after the switch behind an environment variable, so step 7 is a variable change and not a deploy. That means every side effect that leaves Gadget's database: emails, writes to Shopify, calls to other services, the `api.enqueue` calls that make them, and the `shopifyShop` `uninstall` action, which a sync runs on API versions before 2026-04 when the token move gets it a `401`.
5. **Release extensions** that point at the new app.
6. **Switch webhooks and URLs in one deploy.** Change the webhook `uri` values, `application_url`, the app proxy `url`, and the `[auth]` `redirect_urls` in `shopify.app.toml`, then run `shopify app deploy`. If production keeps a custom domain, `application_url` keeps its host, so the DNS change is what moves merchants: make it in the same window as this deploy. On framework versions before 1.7, Gadget's per-store subscriptions also address the custom domain, at `/api/webhooks/shopify`, so after the DNS change they deliver to the new host, which has to accept them at that path until they are deleted. If the app has per-store subscriptions, which apps before framework 1.7 have for every topic and later apps have for metafield models, move them in this window: for each store, run the script in [Delete per-store webhook subscriptions](#delete-per-store-webhook-subscriptions) with the store's access token from Gadget, as in step 2, and create the new app's per-store subscriptions if it has any ([shopify-webhooks.md](shopify-webhooks.md#topics-gadget-handled-for-you)). Until then they keep delivering to Gadget, and on an active store the wait in step 7 never ends. Until step 8, jobs that call Shopify use step 2's tokens.
7. **Drain Gadget and turn it off.** Shopify can take several minutes to move stores to the new version, so wait until webhooks stop reaching Gadget. Wait also until session-token requests stop appearing in Gadget's logs, each logged as `verified shopify session token`: an admin page a merchant opened before the switch keeps calling Gadget until it reloads. Let the background actions queued before the switch finish, then set the environment variable from step 4 in Gadget's production environment, because until Gadget loses access to Shopify, its daily reconciliation runs your actions for every record changed since the switch. Do this before step 8: moving a non-expiring token revokes Gadget's copy, and on API versions before 2026-04 Gadget's next sync would run the `uninstall` action.
8. **Move tokens** for stores the new app has no session for yet ([shopify-tokens.md](shopify-tokens.md)). Gadget's access token for a store works for at most an hour after this. Afterwards, search Gadget's logs for `running token exchange to upgrade`: a session token that reached Gadget after the move made it take the store's tokens back, and the off switch doesn't prevent that. Delete the new app's session for each store it names and move its tokens again ([shopify-tokens.md](shopify-tokens.md)).
9. **Catch up and reconcile.** Run the catch-up export for records that changed in Gadget after the first export, and load it, skipping the ids the new app deleted since the switch: the load would insert those again ([data-export.md](data-export.md#catch-up-on-records-that-change-during-the-export)). Then run the new reconciliation for each store from when its backfill began reading, and skip emails and jobs for records whose Shopify `updated_at` is before webhooks stopped reaching Gadget, which already ran them. A reconciliation never finds a record deleted between the backfill and the switch, because its delete webhook went to Gadget, so for each store list the ids Shopify returns now and delete the rows missing from the list ([shopify-sync.md](shopify-sync.md#delete-records-shopify-deleted-before-the-switch)).
10. **Keep the Gadget app until the records match.** Compare counts and spot-check records between the two apps before deleting the Gadget one.

The deploy doesn't deploy your server. The new app must already be running at the new URLs, with its database migrated, before step 6.

## The IP allowlist

Shopify requires every public app to have an IP allowlist, and requests from outside it get `403`. Apps without one lose bulk operations from 12 November 2026 and all Admin API access from 1 April 2027. Gadget's guide has apps allow Google Cloud's network, ASN `396982`, in the United States.

One allowlist holds IP addresses and ranges as well as networks (ASNs). Shopify checks the listed addresses first, and looks up the ASN and country of every other request. So keep `396982` while Gadget still calls Shopify, and add the new host next to it:

1. Find the address the new host calls from. Send one request from it to any service that shows your IP address, such as `curl -s https://checkip.amazonaws.com` in a one-off job, and send it from more than one instance.
2. In the Dev Dashboard, open the app, click **Settings**, then **Manage** in the **IP allowlist** section.
   - **The host gives you fixed outbound addresses**, such as a NAT gateway's or a static egress IP: add them as addresses, including any IPv6 address the host calls Shopify from. You don't need their ASN. An address only your app uses lets only your servers use a stolen token, where an ASN such as Amazon's `16509` lets every customer on that network use it.
   - **It doesn't:** look the address up in a public ASN registry, such as `whois -h whois.cymru.com " -v <address>"`, and add that ASN and the country the host runs in. Don't assume the network from the host's name: a host that runs on another cloud calls from that cloud's network. The country list narrows only the ASNs, never the addresses.
3. Click **Run test** under **Test against recent traffic**. It checks the last 30 days of requests, so it shows Gadget's traffic passing. It can't show the new host until the new host has called Shopify, so run it again after the backfill starts.

Shopify allows up to 250 addresses or ranges, 10 ASNs, and 10 countries. Google Cloud Run in the United States is already covered by `396982`.

After the Gadget app is deleted, tighten the list: remove `396982` unless the new host is on Google Cloud, or switch the list to the new host's static IP addresses (up to 100 addresses or ranges).

## Never do these during a move

- **Uninstall a store from the Gadget editor.** It revokes the app's access to the store, and the new app is the same Shopify app.
- **Deploy from the Gadget editor after the switch.** On framework 1.7 and later, an editor deploy runs `shopify app deploy` with Gadget's `shopify.app.toml`, which points webhooks and app URLs back at Gadget and registers per-store subscriptions again. If Gadget's code has to change after the switch, deploy it with `ggt deploy`, which doesn't run `shopify app deploy`.
- **Change Shopify models or webhook triggers in Gadget after the switch.** On framework versions before 1.7, a deploy with those changes registers per-store subscriptions again.
- **Delete the Gadget app before per-store subscriptions are gone.** Deleting the app doesn't remove them from Shopify.
- **Build the new app inside the directory you run `ggt` from.** `ggt` pushes every file its `.ignore` file doesn't match, so the new app's files land in Gadget. `.ignore` follows `.gitignore` rules, where a pattern with no leading slash matches at any depth: `routes`, added to keep the new app's folder out, also stops new files under `api/routes` from reaching Gadget. Keep the pulled Gadget app in a directory of its own.

## Delete per-store webhook subscriptions

`shopify app deploy` only changes the app-level subscriptions in `shopify.app.toml`. Apps on framework versions before 1.7 have a subscription per store that Gadget created through the Admin API, and apps on 1.7 and later have per-store subscriptions for metafield models. Those keep sending webhooks to Gadget. With each store's Admin API client, list them, check the list, then delete them:

```typescript
// in scripts/delete-store-subscriptions.ts
const LIST = `#graphql
  query ListSubscriptions($after: String) {
    webhookSubscriptions(first: 250, after: $after) {
      nodes { id topic uri }
      pageInfo { hasNextPage endCursor }
    }
  }`;
const DELETE = `#graphql
  mutation DeleteSubscription($id: ID!) {
    webhookSubscriptionDelete(id: $id) {
      deletedWebhookSubscriptionId
      userErrors { field message }
    }
  }`;

type Admin = { graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response> };

// keepPrefix is the new app's URL. With dryRun, nothing is deleted.
export async function deleteStoreSubscriptions(admin: Admin, keepPrefix: string, dryRun = true) {
  const stale: { id: string; topic: string; uri: string }[] = [];
  let after: string | null = null;
  do {
    const { data } = await (await admin.graphql(LIST, { variables: { after } })).json();
    // every per-store subscription belongs to this app, so one that doesn't point at the new app came from Gadget
    stale.push(...data.webhookSubscriptions.nodes.filter((subscription: { uri: string }) => !subscription.uri.startsWith(keepPrefix)));
    after = data.webhookSubscriptions.pageInfo.hasNextPage ? data.webhookSubscriptions.pageInfo.endCursor : null;
  } while (after);

  for (const subscription of stale) {
    console.log(dryRun ? "would delete" : "deleting", subscription.topic, subscription.uri);
    if (dryRun) continue;
    const { data } = await (await admin.graphql(DELETE, { variables: { id: subscription.id } })).json();
    const errors = data.webhookSubscriptionDelete.userErrors;
    if (errors.length) throw new Error(`${subscription.topic}: ${errors.map((error: { message: string }) => error.message).join(", ")}`);
  }
  return stale;
}
```

The script collects every page before it deletes anything, so the dry run and the real run work from the same list. Run it with `dryRun` first and read the output: it should list only `gadget.app` URLs, or your Gadget app's custom domain. When the new app keeps that custom domain, pass a `keepPrefix` that includes the new app's webhook path, such as `https://app.example.com/webhooks/`, so Gadget's subscriptions at `/api/webhooks/shopify` don't match it.

`webhookSubscriptions` returns only subscriptions created through the API, so the app-level ones from either app's `shopify.app.toml` can't be deleted by mistake. The `uri` field exists on Admin API version 2025-10 and later, which covers the template's version. On an older version, select `callbackUrl` instead.

Gadget registers a store's subscriptions again if it sees that store reinstall the app or change its granted scopes, so run the script once more before you delete the Gadget app.

## Moving back

Decide before the switch what moving back means, because each step undoes differently:

| Step | To undo it |
|---|---|
| Webhooks and URLs | Deploy the old `shopify.app.toml` again. On framework 1.7 and later, a deploy from the Gadget editor does this |
| Tokens | Stores the new app holds a session for have had Gadget's refresh token retired, whether the session came from step 8 or from a merchant who opened the new app after step 6. Copy the new app's current tokens back to the `shopifyShop` record and stop the new app from refreshing, or wait for the merchant to open the app in Gadget, which gets new tokens then |
| Scheduled work and the off switch | Turn the Gadget scheduler triggers back on, deploy, and clear the off switch variable |
| Records written in the new app | Not in Gadget. Export them from the new database and write them back through the API |
| Per-store subscriptions | Choose **Register Webhooks** for every store on the Shopify connection's **Installs** page, then delete the new app's |

Moving back is cheap only for stores the new app holds no session for. Step 8 gives every store one, and before it a store whose merchant has opened the new app already needs its tokens copied back.

## Moving stores in stages

Shopify sends every store to the same `application_url` and delivers each app-level webhook to one address, so step 6 moves every store's traffic at once. That is the default, and the right choice for most apps. A store-by-store move fits the work that isn't tied to those URLs:

- **Tokens and background work.** After step 6, move tokens for a handful of stores first, watch the new app refresh them and run its jobs for those stores, then move the rest. Stores whose tokens haven't moved get new ones when a merchant opens the new app.
- **Web apps without Shopify.** Add a column that says which app handles each customer account and route requests on it at your own domain, since no outside party fixes the URL. Split the work no request starts per account too, as the last paragraphs of this section describe for stores, including the records that belong to no account.

Traffic tied to those URLs can be staged too, but only by building a forwarding layer. The new app becomes the address for every store in step 6, keeps a column that says which app handles each store, and passes requests for stores that haven't moved on to Gadget. What is known about each kind of request:

- **Webhooks forward cleanly.** Gadget checks a Shopify webhook by its HMAC over the raw body, and reads the store and topic from the `X-Shopify-` headers. Send the exact bytes Shopify sent, with those headers, to the Gadget app's webhook URL, and Gadget accepts it. A body that was parsed and serialized again fails the HMAC check. Answer Shopify with the status Gadget returned, inside the same 5 seconds.
- **Admin requests are harder.** The first request for a page names the store in its query string, and API calls carry a session token that names it. The scripts and styles the page then loads name no store, so the forwarder can't route them by store. This skill has no tested recipe for forwarding the embedded admin.
- **Per-store webhook subscriptions don't go through the forwarder.** They deliver straight to Gadget until you delete them for that store.

The token rule decides the order for each store: a merchant request that the forwarder passes to Gadget can make Gadget run a token exchange, which retires tokens the new app holds. So flip a store's column first, then move its tokens, and never forward a request for a store after its flip. This costs a forwarder that must stay up for the whole move, and two apps to watch for as long as it lasts. Forwarding wasn't run end to end for this skill.

A staged move also has to split the work no request starts. Mark each moved store on its `shopifyShop` record, and have Gadget's scheduled actions, the off switch, and the new cron jobs check that mark for each store. Run the catch-up export for each store after its switch, limited to that store's records, and size the id gap from [schema-mapping.md](schema-mapping.md#move-sequences-after-loading) for every record Gadget creates until the last store moves, which over a few weeks can pass 1,000,000 ([Move one store at a time](https://docs.gadget.dev/guides/moving-to-another-platform#move-one-store-at-a-time)). Records that belong to no store, such as app-wide settings, need one app that writes them for the whole move.

Only one app may hold a store's tokens at any time, staged or not.

## Common pitfalls

- **Creating a new Shopify app for the new code.** No store has it installed.
- **Backfilling before the allowlist change.** Every request gets `403` once Shopify enforces the allowlist.
- **Copying refresh tokens for the backfill.** The first refresh by either app retires the other's tokens. Borrow the access token only.
- **Forgetting per-store subscriptions.** Some webhooks keep going to Gadget after the switch.
- **Forgetting webhooks from other services.** They keep arriving at Gadget, or fail once the Gadget app is deleted, and nothing in Shopify's deploy tells you.
- **Deploying from the Gadget editor to fix something after the switch.** It undoes step 6. Use `ggt deploy`.
- **Deleting the Gadget app the same day.** Keep it until the records match.

## Related references

- [shopify-tokens.md](shopify-tokens.md): the token handoff in step 8
- [external-api-clients.md](external-api-clients.md): callers outside the app that also need the new URL
- [bigcommerce.md](bigcommerce.md) and [non-shopify-apps.md](non-shopify-apps.md): cutting over an app without Shopify
- [shopify-sync.md](shopify-sync.md): the backfill and reconciliation in steps 2 and 8
- [data-export.md](data-export.md): the export, the catch-up export, and id sequences
- [background-jobs.md](background-jobs.md): moving queued and scheduled work
- [users-and-auth.md](users-and-auth.md): sign-in for web apps
