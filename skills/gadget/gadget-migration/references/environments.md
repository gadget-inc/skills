# Environments, deploys, and the tools around them

## What is this?

The other references move what runs in production. This one covers what the team used every day and stops having after the move:

| Gadget gave you | What replaces it |
|---|---|
| A development environment per developer, each with its own database, URL, and environment variables | A local database or a database branch per developer, and a `.env` file that is not committed |
| `ggt dev`, which synced local files to a hosted environment | Running the app on your own machine |
| A separate Shopify app per environment, connected for you | A Shopify app per environment that you create and link with the Shopify CLI |
| Deploy: code and database changes applied together, with a check for changes that delete data | A deploy pipeline you write, with migration files |
| Tables that changed when you edited a model | Migrations |
| The data editor, API playground, queues page, and log viewer | A database client, your queue's dashboard, and your host's logs |
| A `gadget.app` URL per environment, and HTTPS on custom domains | Your host's URLs and its domain settings |

None of this breaks production on the day of the move. It decides whether the second deploy goes well.

## Database changes become migrations

On Gadget, adding a field changed the table for you. Renaming a field changed only its name in the API: the stored column was tied to the field's `storageKey`, so no data moved and no running code broke.

Do the same rename in Postgres and it breaks during the deploy. Say the new code reads `display_name` and the migration renames `name` to `display_name`. A rolling deploy runs the migration first and then replaces servers over a few minutes. For those minutes the old servers still select `name`, and every request they handle fails with `column "name" does not exist`.

Make each change in steps that old and new code can both live with:

1. **Expand.** Add `display_name` as a nullable column. Deploy code that writes both columns and still reads `name`.
2. **Backfill.** Copy `name` into `display_name` for existing rows, in batches.
3. **Switch.** Deploy code that reads `display_name`.
4. **Contract.** In a later deploy, stop writing `name` and drop it.

The same steps apply to dropping a column, adding `not null`, and changing a type. Adding a nullable column or a new table needs no steps.

Use your database client's migration tool, such as Prisma Migrate or Drizzle Kit, and commit the migration files. Three rules keep deploys boring:

- **Run migrations once per deploy, before the new code starts**, from a release step or a one-off job. Do not run them from every server at boot, where several servers race each other.
- **Create the first migration from the schema you built for the import**, and mark it as already applied in production. The tables exist there.
- **Build indexes on large tables with `create index concurrently`**, outside a transaction. A plain `create index` blocks writes to the table until it finishes, which is minutes on a table with millions of rows.

Gadget warned before a deploy that would delete data. Nothing warns now. Read every generated migration for `drop` before it merges.

## Development environments

Each developer needs what a Gadget development environment was: the app running somewhere, a database nobody else writes to, and for Shopify apps, a Shopify app whose URLs point at it.

- **Database.** Postgres in Docker on the developer's machine, or a branch per developer on a provider that has branching, such as Neon or Supabase. Add a seed script that creates enough records to work with. Do not point development at the production database.
- **Environment variables.** Gadget stored a value per environment. Keep a committed `.env.example` with the names and an uncommitted `.env` with development values. Production values live in the host's secret settings.
- **Shopify.** `shopify app dev` runs the app, opens a tunnel, and points a development app's URLs at it. Give each environment its own Shopify app and its own config file, such as `shopify.app.development.toml` and `shopify.app.staging.toml`, created with `shopify app config link`. Apps on framework version 1.7 and later already have this layout, with one TOML file per Gadget environment. Never run `shopify app dev` with the production config, because it can point the production app's URLs at your tunnel.
- **Webhooks from other services.** A local server has no public URL. Use the service's CLI to forward events, such as `stripe listen`, or a tunnel.

## Staging and previews

A Gadget development environment often doubled as staging. Keep one long-lived staging deployment with a fixed URL, its own database, and its own Shopify app. Per-pull-request preview deployments work for web apps, but an embedded Shopify app needs its URL registered with Shopify, and a preview URL that changes on every pull request is not registered anywhere.

## Deploys

`ggt deploy` or the editor's deploy button becomes a pipeline. The order matters:

1. Run tests.
2. Run migrations against production.
3. Deploy the new code and wait for it to be healthy.
4. Run `shopify app deploy` only when `shopify.app.toml` or an extension changed. It releases a new app version to every store.

Gadget had no rollback button, and the documented way back was deploying an earlier commit. The same works here for code. It does not undo a migration, which is the other reason for the expand and contract steps: the previous version of the code must still run against the current tables.

In CI, replace the `ggt` deploy token with your host's deploy credentials and, for Shopify apps, a Shopify CLI token.

## The editor's tools

Plan replacements before the first production incident, not during it:

- **Data editor.** A database client such as `psql`, Prisma Studio, or Drizzle Studio. Connect with a read-only role by default. A database client writes straight to the tables, past every validation in your code.
- **API playground.** Tests, and scripts that call your functions.
- **Queues page.** Your queue's dashboard, such as Bull Board for BullMQ, or the Inngest and Trigger.dev dashboards. Check that it can retry a failed job by hand, which the queues page could.
- **Log viewer.** Your host's logs, with a log drain to a service that keeps them as long as you need. Log the store or user id on every line, so one tenant's requests can be found.
- **Operations dashboard.** Your host's metrics, plus an alert on error rate and on queue depth.

## Domains

A `gadget.app` URL stays with Gadget. Custom domains move: add the domain in the new host's settings, wait for it to issue a certificate, then change the DNS record. Lower the record's TTL a day before, so the change takes effect in minutes. An apex domain such as `example.com` can't hold a `CNAME` record, so use the host's `A` record or your DNS provider's `ALIAS` or flattened `CNAME`.

Everything that names the old domain needs the new one: Shopify or BigCommerce app URLs, OAuth redirect URLs for Google sign-in, links in emails, and webhook URLs saved in other services ([external-api-clients.md](external-api-clients.md)).

## Common pitfalls

- **Renaming or dropping a column in one deploy.** Old servers fail until the rollout finishes.
- **Running migrations from every server at boot.** Two servers apply the same migration at once.
- **Sharing one development database.** One developer's migration breaks everyone else's branch.
- **Running `shopify app dev` with the production config.** It can point production's URLs at a laptop.
- **No replacement for the queues page.** The first failed job has nowhere to be seen or retried.

## Related references

- [schema-mapping.md](schema-mapping.md): the schema the first migration is made from
- [cutover.md](cutover.md): the production switch
- [background-jobs.md](background-jobs.md): the queues that need a dashboard
