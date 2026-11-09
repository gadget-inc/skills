# Cutting over

## What is this?

The cutover is the hour where Shopify stops talking to Gadget and starts talking to the new app. Most failures come from doing the right steps in the wrong order: tokens moved while Gadget still receives requests, a backfill from a host Shopify rejects, or a Gadget deploy that quietly points everything back. Build and test the new app against a development store first, then follow this order for production.

## The order

1. **Allow the new host to call Shopify.** Shopify requires public apps to restrict API access to the networks they call from, and Gadget's guide has apps allow Google Cloud's ASN, `396982`, in the United States. Before the new host calls Shopify, add its ASN and country in the Dev Dashboard under **Settings** > **IP allowlist**, next to `396982`, and run the test against recent traffic. The allowlist holds ASNs or IP addresses, not both, so use your host's ASN even if it gives you a static IP. Google Cloud Run in the United States is already covered by `396982`.
2. **Backfill Shopify data** for every store ([shopify-sync.md](shopify-sync.md)).
3. **Load custom models** and move each id sequence ([data-export.md](data-export.md), [schema-mapping.md](schema-mapping.md)).
4. **Move scheduled work.** Turn off the scheduler triggers in the Gadget app, including `scheduledShopifySync`, and turn on the new cron jobs. Recreate background actions with a future `startAt` in the new queue.
5. **Release extensions** that point at the new app.
6. **Switch webhooks and URLs in one deploy.** Change the webhook `uri` values, `application_url`, the app proxy `url`, and the redirect URLs in `shopify.app.toml`, then run `shopify app deploy`.
7. **Move tokens** for stores the new app has no session for yet ([shopify-tokens.md](shopify-tokens.md)).
8. **Drain Gadget and reconcile.** Let background actions queued before the switch finish. Remove emails and Shopify writes from Gadget actions that can still run, such as those its daily reconciliation runs for stores with non-expiring tokens. Then run the new reconciliation for the hours around the switch.
9. **Keep the Gadget app until the records match.** Compare counts and spot-check records between the two apps before deleting the Gadget one.

## Never do these during a move

- **Uninstall a store from the Gadget editor.** It removes the app from the store, and the new app is the same Shopify app.
- **Deploy the Gadget app after the switch.** On framework 1.7 and later, an editor deploy runs `shopify app deploy` with Gadget's `shopify.app.toml`, which points webhooks and app URLs back at Gadget and re-registers per-store subscriptions you deleted.

## Delete per-store webhook subscriptions

`shopify app deploy` only changes the app-level subscriptions in `shopify.app.toml`. Apps on framework versions before 1.7 have a subscription per store that Gadget created through the Admin API, and apps on 1.7 and later have per-store subscriptions for metafield models. Those keep sending webhooks to Gadget. With each store's token, list and delete them:

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

let after: string | null = null;
do {
  const { data } = await (await admin.graphql(LIST, { variables: { after } })).json();
  for (const subscription of data.webhookSubscriptions.nodes) {
    // per-store subscriptions belong to this app, so anything not pointing at the new app came from Gadget
    if (subscription.uri.startsWith(process.env.SHOPIFY_APP_URL!)) continue;
    const result = await (await admin.graphql(DELETE, { variables: { id: subscription.id } })).json();
    if (result.data.webhookSubscriptionDelete.userErrors.length) console.error(subscription, result.data.webhookSubscriptionDelete.userErrors);
  }
  after = data.webhookSubscriptions.pageInfo.hasNextPage ? data.webhookSubscriptions.pageInfo.endCursor : null;
} while (after);
```

`webhookSubscriptions` returns only subscriptions created through the API, so the app-level ones from either app's `shopify.app.toml` can't be deleted by mistake.

## Move one store at a time

If you can, move a few stores first. Add a column to the shops table in both apps that says which app handles the store, have both apps check it before processing a webhook or running a job, and flip a handful of stores. If something goes wrong, flip them back without losing data. The token rules still apply per store: only one app may hold a store's tokens.

## Common pitfalls

- **Backfilling before the allowlist change.** Every request gets `403` once Shopify enforces the allowlist.
- **Moving tokens before releasing extensions.** An extension that still calls Gadget can make Gadget run a token exchange that retires the new app's tokens.
- **Leaving Gadget's scheduled actions on.** Emails and Shopify writes happen twice.
- **Forgetting per-store subscriptions.** Some webhooks keep going to Gadget after the switch.
- **Deleting the Gadget app the same day.** Keep it until the records match.

## Related references

- [shopify-tokens.md](shopify-tokens.md): the token handoff in step 7
- [shopify-sync.md](shopify-sync.md): the backfill and reconciliation in steps 2 and 8
