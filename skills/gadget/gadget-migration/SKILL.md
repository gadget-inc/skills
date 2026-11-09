---
name: gadget-migration
description: Move a Gadget app to another platform, such as Shopify's React Router template on Cloud Run, Render, Fly.io, Vercel, or Railway, or Supabase, Convex, AWS, or Google Cloud. Use when exporting records from Gadget, mapping Gadget models and fields to Postgres, Prisma, or Drizzle, porting actions (run and onSuccess), background actions (api.enqueue), and scheduled actions to BullMQ, Cloud Tasks, Inngest, Trigger.dev, or cron, rebuilding shop tenancy (Gelly filters to row-level security), rebuilding the Shopify connection (webhook HMAC verification, app proxy signatures, session tokens, duplicate and out-of-order webhooks, reconciliation, expiring offline token refresh and handoff), replacing @gadgetinc/react hooks, or planning the cutover. Also use for verifying Shopify webhooks, app proxy requests, or session tokens outside Gadget.
---

# Moving a Gadget app to another platform

A Gadget app is several services in one: a Postgres database, an API generated from your models, servers for actions and HTTP routes, a job queue, a scheduler, file storage, search, email, frontend hosting, and a Shopify connection. Gadget also did things your code never saw: it verified every request from Shopify, scoped every query to the current store, ignored stale webhooks, retried failed jobs, and refreshed Shopify tokens. A move means rebuilding each of these on purpose. The ones nobody rebuilds are the ones that break in production.

This skill gives you the order of work, code that runs on any Node-compatible host, and the pitfalls for each step. Gadget's public guide covers the same steps for people: https://docs.gadget.dev/guides/moving-to-another-platform

## Start with an inventory

Pull the production environment and list everything the move has to replace:

```bash
ggt pull --app my-app --env production
node path/to/skills/gadget-migration/scripts/inventory.ts . > MIGRATION_INVENTORY.md
```

`scripts/inventory.ts` needs Node 22.18+ or 23.6+ and no dependencies. It lists every model with its field types, the fields that need extra steps, relationships, actions with their triggers, `api.enqueue` calls and their options, scheduled actions, HTTP routes, roles and Gelly filters, frontend hooks, environment variables, and the webhook topics and URLs in `shopify.app.toml`. Each section names the reference below that covers it. It scans action and frontend files as text, so confirm what it reports against the code.

## Order of work

1. **Choose the platform.** Each part of the app needs a replacement: database, job queue, scheduler, sign-in, file storage, email, search.
2. **Map the schema and export data.** [references/schema-mapping.md](references/schema-mapping.md), [references/data-export.md](references/data-export.md)
3. **Port actions.** [references/actions-and-transactions.md](references/actions-and-transactions.md)
4. **Port background and scheduled actions.** [references/background-jobs.md](references/background-jobs.md)
5. **Rebuild shop tenancy and permissions.** [references/shop-tenancy.md](references/shop-tenancy.md)
6. **Rebuild the Shopify connection.** [references/shopify-signatures.md](references/shopify-signatures.md), [references/shopify-webhooks.md](references/shopify-webhooks.md), [references/shopify-sync.md](references/shopify-sync.md), [references/shopify-tokens.md](references/shopify-tokens.md)
7. **Replace the frontend client.** [references/frontend.md](references/frontend.md)
8. **Move users and sign-in.** [references/users-and-auth.md](references/users-and-auth.md)
9. **Cut over.** [references/cutover.md](references/cutover.md)

## Rules that hold in every step

- **Keep every record id.** Gadget ids are numbers sent as strings, and records in Shopify models use Shopify's ids. Relationships point at them.
- **Database writes go in one transaction, and outside calls happen after it commits.** That was the split between `run` and `onSuccess`.
- **Every write from Shopify checks `updated_at`.** Shopify doesn't deliver webhooks in order, so a write without the check can replace new data with old.
- **Every query is scoped to one store.** Take the store from a verified session token or webhook header, never from the request body.
- **Every job can run twice.** Queues retry, and Shopify resends webhooks.
- **Only one app holds a store's Shopify tokens at a time.** Two apps refreshing the same store retire each other's tokens.
- **Every request from Shopify is verified.** Use `assets/shopify-signatures.ts`, or the template's `authenticate.*` helpers.

## What Gadget can't give you on the way out

Plan around these. They are true today and may change:

- **No direct database access.** Records leave through the data editor's CSV export or the API, at most 250 per request. A 2.4 million record model takes 9,600 requests.
- **No bulk file download.** Each file leaves through its URL. Private file URLs expire 3 hours after you read the record.
- **No one-step token handoff.** You read each store's tokens through the Internal API and clear Gadget's refresh token yourself, in the order [references/shopify-tokens.md](references/shopify-tokens.md) gives.
- **No secret values.** `ggt var get` reads non-secret environment variables only. Get secret values from the service that issued them.

## Files in this skill

- `scripts/inventory.ts`: the inventory above
- `assets/shopify-signatures.ts`: webhook HMAC, OAuth `hmac`, app proxy `signature`, and session token verification with Web Crypto only. Copy it into the new app unchanged.
- `references/*.md`: one file per step, each with code and the pitfalls that step tends to hit
