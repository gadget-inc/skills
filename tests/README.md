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
- `gadget-migration/coverage-*.test.ts`: the BigCommerce verifier in `assets/bigcommerce-signed-payload.ts`, the API key code in `references/external-api-clients.md`, and the Hookdeck signature check in `references/shopify-webhooks.md`.

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
