# Tests

The gadget-migration tests run the skill's code and the snippets in its references, so a reference that changes in a way that breaks its code fails a test. Snippet tests find each code block by the path comment on its first line, such as `// in app/db/withShop.server.ts`.

## Unit tests

No dependencies, Node 22.18+ or 23.6+:

```bash
node --test "tests/**/*.test.ts"
```

- `gadget-migration/shopify-signatures.test.ts`: `assets/shopify-signatures.ts` against Shopify's published examples (the OAuth callback and both app proxy examples, signed with the secret `hush`) and against forged, reordered, re-split, and stale requests.
- `gadget-migration/shopify-tokens.test.ts`: the token refresh and exchange code in `references/shopify-tokens.md`, against a local stand-in for Shopify's token endpoint.
- `gadget-migration/shopify-token-move.test.ts`: the token move script in `references/shopify-tokens.md`, against stand-ins for the Gadget client, Prisma, and Shopify's token endpoint in `fixtures/fake-token-move`. It covers stores Shopify refuses, reruns, and a run that dies between saving a session and clearing Gadget's refresh token.
- `gadget-migration/inventory.test.ts`: `scripts/inventory.ts` on the sample app in `gadget-migration/fixtures/sample-app`.
- `gadget-migration/data-export.test.ts`: the export script in `references/data-export.md`, against the fake client in `fixtures/fake-gadget-client`, including failed requests and restarts.
- `gadget-migration/coverage-*.test.ts`: the BigCommerce verifier in `assets/bigcommerce-signed-payload.ts` and the API key code in `references/external-api-clients.md`.

## Integration tests

Each folder has its own `package.json`. Run `npm install` once in each.

Postgres and Redis, from `gadget-migration/integration`. `DATABASE_URL` must be a superuser, because the tests create scratch databases and the `app_user` and `storefront_user` roles. Without `REDIS_URL` the BullMQ tests skip, and without `PGBOUNCER_BIN` the connection pooler tests skip. `schema.integration.ts` skips its vector test when pgvector isn't installed.

```bash
cd tests/gadget-migration/integration
DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres REDIS_URL=redis://127.0.0.1:6379 PGBOUNCER_BIN=$(which pgbouncer) npm test
```

`PGBOUNCER_PORT` changes the pooler's port (default 64352).

Shopify's app library, from `gadget-migration/shopify-template`, against a local stand-in for Shopify. The tests that run `claimInstall` from `references/shopify-webhooks.md` inside the library's `afterAuth` hook, and drain its jobs with the outbox code from `references/actions-and-transactions.md`, need Postgres and skip without `DATABASE_URL`:

```bash
cd tests/gadget-migration/shopify-template
DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres npm test
```

Password imports through bcryptjs and Better Auth, from `gadget-migration/auth`:

```bash
cd tests/gadget-migration/auth
npm test
```

The webhook subscription cleanup script in `references/cutover.md`, from `gadget-migration/cutover`. One test validates its GraphQL against Shopify's public Admin API schema and skips without network access:

```bash
cd tests/gadget-migration/cutover
npm test
```

Search, live updates, computed views, user tenancy, and pgvector, from `gadget-migration/coverage-postgres`:

```bash
cd tests/gadget-migration/coverage-postgres
DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres npm test
```

Presigned uploads and downloads with the AWS SDK, offline, from `gadget-migration/coverage-files`:

```bash
cd tests/gadget-migration/coverage-files
npm test
```

## Platform references

The files in `references/platforms/`, `scripts/preflight.ts` with its check modules in `scripts/checks/`, and `scripts/db-check.sql` have tests of their own.

**Unit tests**, in the run above: `gadget-migration/platforms-<platform>.test.ts` runs each platform's checks against a fake app in `fixtures/preflight/<platform>-bad`, which should trigger every check at the right file and line, and `<platform>-good`, which should trigger none. `platforms-common.test.ts` also covers the YAML, TOML, JSONC, and Dockerfile readers and the command line.

**Integration tests**, one folder per platform with its own `package.json`. Run `npm install`, then `npm test`, in each. Each test skips when the service it needs isn't given. `platform-blocks.ts` writes a reference's TypeScript blocks into a project, with stubs for app files the reference doesn't show, and runs `tsc` on them, so every folder typechecks its reference's code.

| Folder | What it runs | Needs |
|---|---|---|
| `platforms-common` | `db-check.sql` as a superuser, a role without a policy, and through PgBouncer; the one-transaction load script; the prepared statement check; Prisma's errors for the template's SQLite migration; the BullMQ worker built with `build:worker` and stopped mid-job | `DATABASE_URL` (superuser), `PGBOUNCER_URL` and `PGBOUNCER_NO_PREPARED_URL` (PgBouncer in transaction mode with `max_prepared_statements` at 100 and at 0, without a database name), `REDIS_URL` (a Redis nothing else uses) |
| `platforms-render` | The Blueprint against Render's JSON schema, BullMQ on Valkey with `allkeys-lru` and `noeviction`, stalled jobs, Prisma Migrate's lock through PgBouncer, the Workflows starter against a stand-in API | `DATABASE_URL`, `PGBOUNCER_URL` (transaction mode, same server), Docker, network access for the schema |
| `platforms-railway` | The project file against the `railway` package, the Redis append-only switch on `redis:8.2`, ioredis on an IPv6-only network, presigned bucket URLs | Docker |
| `platforms-fly-io` | Both `fly.toml` files with `fly config validate --strict`, the Dockerfile and `supercronic -test`, web and worker shutdown on Valkey, Prisma's `release_command` | `FLYCTL` (a flyctl binary), `DATABASE_URL`, Docker |
| `platforms-google-cloud` | Every `gcloud` command in the IAM and deploy scripts, parsed by the Google Cloud CLI image; the Cloud Tasks helpers against a stub; the Shopify library's startup errors | Docker with `gcr.io/google.com/cloudsdktool/google-cloud-cli:alpine` |
| `platforms-aws` | The TypeScript blocks typechecked with the AWS SDK and Prisma; the scheduled job and its `security definer` function on PostgreSQL 18 as an RDS-like master user; `withTaskProtection` against a stand-in ECS agent; `scripts/aws-queues.sh` and `enqueue` against AWS Emulator | Docker with `postgres:18`; AWS Emulator's image (`AWS_EMULATOR_IMAGE`, default `aws-emulator:latest`) and the AWS CLI for the emulator tests, which skip without them |
| `platforms-azure` | Every `az` command in the setup, apps, and deploy scripts, parsed by the Azure CLI 2.88.0 image; the TypeScript blocks typechecked; the admin user, `app_user`, and `db-check.sql` on PostgreSQL 17; Prisma through PgBouncer 1.26.1 with `max_prepared_statements` at 0 and 200; uploads, CORS, and the file redirect route on Azurite 3.37.0 | Docker with `mcr.microsoft.com/azure-cli:2.88.0`, `postgres:17`, `edoburu/pgbouncer` (1.26.1), and `mcr.microsoft.com/azure-storage/azurite` |
| `platforms-supabase` | The migration set, the pgmq worker, the role password script, and the exposure query on Supabase's Postgres image `17.11.0.018`. `stack.integration.ts` also needs the full local stack from `npx supabase@3.1.0 start` in that folder | Docker; for the stack test, `SUPABASE_URL`, `SUPABASE_DB_URL`, `SUPABASE_POOLER_URL`, and the keys from `npx supabase status` |
| `platforms-vercel` | `vercel build` offline on Shopify's React Router template, and the schedule service through PgBouncer | `DATABASE_URL`, `PGBOUNCER_URL` |
| `platforms-cloudflare` | Shopify's template built and served by the Cloudflare Vite plugin against Postgres, `wrangler deploy --dry-run` for each environment, the session storage, R2 signing against an S3-compatible server | `DATABASE_URL`, Docker for R2 |
| `platforms-inngest` | The functions file, `enqueue`, and the requeue script against the Inngest Dev Server | `INNGEST_CLI` (an inngest-cli 1.51.0 binary) |
| `platforms-trigger-dev` | The config, tasks, and scripts typechecked and run against a stand-in for Trigger.dev's API | nothing |
| `platforms-hookdeck` | The filter writer, audit, and delivery groups against a stand-in that checks requests against Hookdeck's OpenAPI schemas, and the cleanup job | `DATABASE_URL` |

For example, with the services these tests were written against:

```bash
cd tests/gadget-migration/platforms-common
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres PGBOUNCER_URL=postgres://postgres:postgres@127.0.0.1:6432 PGBOUNCER_NO_PREPARED_URL=postgres://postgres:postgres@127.0.0.1:6433 REDIS_URL=redis://127.0.0.1:6380 npm test
```
