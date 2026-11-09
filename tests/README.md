# Tests

## Unit tests

No dependencies, Node 22.18+ or 23.6+:

```bash
node --test "tests/**/*.test.ts"
```

- `gadget-migration/shopify-signatures.test.ts` checks `assets/shopify-signatures.ts` against Shopify's published examples (the OAuth callback and both app proxy examples, signed with the secret `hush`) and against forged, reordered, and re-split requests.
- `gadget-migration/inventory.test.ts` runs `scripts/inventory.ts` on the sample app in `gadget-migration/fixtures/sample-app`.

## Integration tests

These run the SQL and TypeScript snippets from the gadget-migration references against Postgres and Redis. They read each snippet from the reference file by the path comment on its first line, so a test fails if a reference changes in a way that breaks its code.

```bash
cd tests/gadget-migration/integration
npm install
DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres REDIS_URL=redis://127.0.0.1:6379 npm test
```

`DATABASE_URL` must be a superuser, because the tests create a scratch database and an `app_user` role. Without `REDIS_URL`, the BullMQ tests are skipped.
