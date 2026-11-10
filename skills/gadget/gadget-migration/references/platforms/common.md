# Pitfalls on every host

## What is this?

Gadget's guides for each platform repeat a handful of mistakes, because they happen on every host: a URL that loses its slash, a migration written for SQLite, a worker that never hears `SIGTERM`, a database role that skips row-level security. This file covers those once. Read it before the platform file, then read the platform file for what changes there:

| Moving to | Reference | Docs guide |
|---|---|---|
| Vercel | [vercel.md](vercel.md) | https://docs.gadget.dev/guides/moving-to-another-platform/vercel |
| Render | [render.md](render.md) | https://docs.gadget.dev/guides/moving-to-another-platform/render |
| Railway | [railway.md](railway.md) | https://docs.gadget.dev/guides/moving-to-another-platform/railway |
| Fly.io | [fly-io.md](fly-io.md) | https://docs.gadget.dev/guides/moving-to-another-platform/fly-io |
| Google Cloud Run | [google-cloud-run.md](google-cloud-run.md) | https://docs.gadget.dev/guides/moving-to-another-platform/google-cloud-run |
| Supabase | [supabase.md](supabase.md) | https://docs.gadget.dev/guides/moving-to-another-platform/supabase |
| Cloudflare Workers | [cloudflare.md](cloudflare.md) | https://docs.gadget.dev/guides/moving-to-another-platform/cloudflare |
| Hookdeck for webhooks | [hookdeck.md](hookdeck.md) | https://docs.gadget.dev/guides/moving-to-another-platform/hookdeck |
| Inngest for jobs | [inngest.md](inngest.md) | https://docs.gadget.dev/guides/moving-to-another-platform/inngest |
| Trigger.dev for jobs | [trigger-dev.md](trigger-dev.md) | https://docs.gadget.dev/guides/moving-to-another-platform/trigger-dev |

The examples use Shopify's React Router app template, Prisma, and BullMQ, because most Gadget apps move to that stack. The checks work the same with other frameworks and clients.

## Checks to run

Run the preflight script against the new app's repository. It finds every platform it can see from the config files, and `--platform` picks them yourself:

```bash
node path/to/skills/gadget-migration/scripts/preflight.ts path/to/new-app
node path/to/skills/gadget-migration/scripts/preflight.ts path/to/new-app --platform render
```

It needs Node 22.18+ or 23.6+ and no dependencies, and it exits with 1 when it finds an error. Each finding gives the file and line, the error you'd see, the fix, and the docs section. Findings under "Check by hand" are things only a dashboard, CLI, or database can show. `--json` prints the same findings for another script.

Then check the database as the app sees it. Use the exact URL the app connects with, pooled or not, because the role and the pooler are what you're checking:

```bash
psql "$DATABASE_URL" -f path/to/skills/gadget-migration/scripts/db-check.sql
```

| Check | What a problem means |
|---|---|
| role bypasses row-level security | You're connected as a superuser or a role with `BYPASSRLS`, such as Railway's `postgres` or Supabase's `postgres`. Every shop policy is ignored, so a query with no store set returns all 300 stores' rows. |
| owns tables with row-level security | The role ran the migrations, so it owns the tables and skips their policies, as `fly-user` does on Fly.io. Connect the app as another role, or `alter table ... force row level security`. |
| tables with no policy for this role | Row-level security is on and nothing grants this role rows, so reads return 0 rows with no error. |
| pgvector reachable | `vector` lives in a schema this role can't use or doesn't search, as on Supabase. Similarity queries fail with `operator does not exist: extensions.vector <=> unknown`. |
| port | psql reached a different port than Postgres listens on, so a pooler, proxy, or port mapping is in between. The load script and migrations need the direct URL. |
| connections | The connection limit, to size each process's pool against: instances times pool size, plus migrations and one-off jobs, stays under it. |

Three checks need the host itself:

- **Redis eviction:** `redis-cli -u "$REDIS_URL" CONFIG GET maxmemory-policy` should print `noeviction`. Managed Redis that disables `CONFIG` shows it in its settings instead.
- **The egress address and its network:** run `curl -s https://checkip.amazonaws.com` on the host, such as in a one-off job, then `whois -h whois.cymru.com " -v <address>"`. Plain `whois` leaves the ASN empty for AWS addresses. Add the ASN and country to Shopify's IP allowlist next to Gadget's ASN, `396982`, as [IP allowlists](https://docs.gadget.dev/guides/moving-to-another-platform#ip-allowlists) explains.
- **The deployed app's environment:** compare `ggt var list` with the host's variable names before the switch. A worker or job runner that imports `shopify.server.ts` needs `SHOPIFY_API_KEY` and `SHOPIFY_APP_URL` too, or it fails at startup.

## Failure signatures

| You see | Cause | Fix |
|---|---|---|
| A request to `https://app.example.comapi/callback`, or a 404 on a path that exists | Code adds a path to `GADGET_APP_URL`, which ends with `/`, and the new value doesn't | `new URL("api/callback", process.env.SHOPIFY_APP_URL)` ([Environment variables](https://docs.gadget.dev/guides/moving-to-another-platform#environment-variables)) |
| `TypeError: Invalid URL` | A host-only variable, such as `VERCEL_URL` or `RAILWAY_PUBLIC_DOMAIN`, used as a URL | Add `https://`, or use your own `SHOPIFY_APP_URL` |
| `type "datetime" does not exist` during `prisma migrate deploy` | Shopify's template ships a SQLite migration (`"expires" DATETIME`) | Delete `prisma/migrations`, run `prisma migrate dev --name init` against a local Postgres, commit ([Install and authenticate merchants](https://docs.gadget.dev/guides/moving-to-another-platform#install-and-authenticate-merchants)) |
| `@prisma/client did not initialize yet` | The image starts with `npm run start` instead of the template's `docker-start`, so nothing runs `prisma generate` after the schema is copied in | `RUN npx prisma generate` after `COPY . .` in the Dockerfile |
| `prepared statement "s0" already exists` | A pooler in transaction mode that doesn't keep prepared statements | Add `pgbouncer=true` to a Prisma URL, or turn prepared statements off in your client. See [Prepared statements through a pooler](#prepared-statements-through-a-pooler) |
| `relation "widget_import" does not exist`, or `already exists` on a second run | The load script ran through a pooler in transaction mode | Load over the direct URL ([Load your records](https://docs.gadget.dev/guides/moving-to-another-platform#load-your-records)) |
| `remaining connection slots are reserved for roles with the SUPERUSER attribute`, or `sorry, too many clients already` | Instances times pool size is over the limit | Smaller pools, a cap on instances, or the host's pooler |
| `unrecognized configuration parameter "app.shop_id"` | A query ran without the store set, as a role the policy applies to | Expected: set the store in the transaction. Seeing rows instead means the role skips row-level security |
| `IMPORTANT! Eviction policy is allkeys-lru. It should be "noeviction"` in the BullMQ log | Redis deletes keys when full, and queued jobs vanish without an error | Set `maxmemory-policy noeviction` |
| `OOM command not allowed when used memory > 'maxmemory'` | Redis with `noeviction` is full | Expected with `noeviction`: the add fails loudly and can retry. Add memory |
| `job stalled more than allowable limit` | A worker was killed mid-job more than `maxStalledCount` times, usually by deploys | Close workers on `SIGTERM` and give the host a drain time longer than your longest job |
| `Detected an empty appUrl configuration`, then `Missing values for: apiKey` | A process that imports `shopify.server.ts` is missing `SHOPIFY_APP_URL` or `SHOPIFY_API_KEY` | Set the Shopify variables on every service that runs the image |
| `403` from Shopify's Admin API after enforcement | The IP allowlist doesn't include the host's network or country | Add the ASN and country, or run the job on the host |

## Complete examples

### Build URLs from the app's origin

`GADGET_APP_URL` is `https://my-app.gadget.app/`, with a slash. Every replacement lacks one: your own `SHOPIFY_APP_URL`, `RENDER_EXTERNAL_URL`, and Railway's and Vercel's host-only variables. Build each URL with `new URL`, which handles both:

```typescript
// in app/app-url.server.ts
// SHOPIFY_APP_URL is the origin Shopify's app template reads, such as https://app.example.com
export function appUrl(path: string): string {
  const origin = process.env.SHOPIFY_APP_URL;
  if (!origin) throw new Error("set SHOPIFY_APP_URL to this environment's origin, such as https://app.example.com");
  // a relative path like "api/callback" resolves against the origin, with or without a trailing slash
  return new URL(path.replace(/^\/+/, ""), origin.endsWith("/") ? origin : `${origin}/`).toString();
}
```

`appUrl("api/callback")` and `appUrl("/api/callback")` both return `https://app.example.com/api/callback`, whether the variable ends with a slash or not.

### Run a BullMQ worker that drains on deploy

Render, Railway, and Fly.io all stop a worker by sending `SIGTERM` and then killing it after a drain time you set. A worker that ignores the signal loses the jobs it holds, and BullMQ reruns them about 30 seconds later, or fails them with `job stalled more than allowable limit` once a job has stalled more than `maxStalledCount` times (1 by default). These three files run the queue, the worker, and the web server's half of the shutdown. They need `bullmq` and `ioredis` in `dependencies`; BullMQ 6 no longer installs ioredis itself.

```typescript
// in app/queues.server.ts
import { Queue } from "bullmq";
import IORedis from "ioredis";

// family 0 tries IPv4 and IPv6, which private networks on Railway and Fly.io need.
// BullMQ workers need maxRetriesPerRequest set to null.
export const connection = new IORedis(process.env.REDIS_URL!, { family: 0, maxRetriesPerRequest: null });

export const externalQueue = new Queue("external", {
  connection,
  // 7 attempts with 1, 2, 4, 8, 16, and 32 second waits, like Gadget's 6 default retries
  defaultJobOptions: { attempts: 7, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: 1000, removeOnFail: 5000 },
});
```

```typescript
// in app/worker.server.ts
import { Worker } from "bullmq";
import { connection } from "./queues.server";
import { notifyExternalSystem } from "./services/external.server";

const worker = new Worker("external", async (job) => await notifyExternalSystem(job.data.orderId), { connection, concurrency: 10 });

worker.on("failed", (job, error) => console.error(`job ${job?.id} failed on attempt ${job?.attemptsMade}`, error));

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`${signal}: taking no new jobs, closing after the running ones finish`);
  // stops taking jobs and waits for the running ones to finish
  await worker.close();
  await connection.quit();
  process.exit(0);
}
// SIGTERM on Render, Railway, Cloud Run, and Fly.io with kill_signal = "SIGTERM"; SIGINT is Fly.io's default and Ctrl+C
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
```

```typescript
// in app/entry.server.tsx
// add to the template's entry file: react-router-serve closes its HTTP server on SIGTERM, but Node keeps
// running while the Redis connection that webhook routes use to add jobs is open
import { connection, externalQueue } from "./queues.server";

process.once("SIGTERM", async () => {
  await externalQueue.close();
  await connection.quit();
});
```

The worker's handler only runs if the signal reaches Node, so start the worker with `node` and a compiled file. pnpm didn't pass `SIGTERM` on in a test on `node:22-alpine`, and Node's Docker guidance warns that npm can swallow it. The template's Dockerfile installs production dependencies only and its TypeScript imports have no file extensions, so bundle the worker during the build with esbuild, listed under `dependencies`:

```json
// in package.json
{
  "scripts": {
    "build": "react-router build && npm run build:worker",
    "build:worker": "esbuild app/worker.server.ts --bundle --platform=node --format=esm --packages=external --outfile=build/worker.js"
  }
}
```

Then start the worker with `node build/worker.js`. `--packages=external` leaves `bullmq`, `@prisma/client`, and the rest to load from `node_modules` at runtime.

### Load records through any pooler

The main guide's load script needs one connection for its whole run. When the only URL you can reach goes through a pooler in transaction mode, as on Cloud SQL with Managed Connection Pooling, run it as one transaction, so every statement stays on one server connection and the temporary table is dropped at the end:

```sql
-- in scripts/load-widgets-pooled.sql
-- run with: psql -1 "$DATABASE_URL" -f scripts/load-widgets-pooled.sql
create temp table widget_import (record jsonb) on commit drop;

\copy widget_import (record) from 'widget.ndjson' with (format csv, quote e'\x01', delimiter e'\x02')

insert into widget (id, name, created_at, updated_at)
select distinct on ((record->>'id')::bigint)
  (record->>'id')::bigint,
  record->>'name',
  (record->>'createdAt')::timestamptz,
  (record->>'updatedAt')::timestamptz
from widget_import
order by (record->>'id')::bigint, (record->>'updatedAt')::timestamptz desc
on conflict (id) do update
  set name = excluded.name,
      updated_at = excluded.updated_at
  where widget.updated_at < excluded.updated_at;
```

One transaction holds its locks and its write-ahead log until the end, so load a 2.4-million-record model this way only when no direct URL exists.

### Prepared statements through a pooler

Whether your client works through a transaction-mode pooler depends on the client and the pooler's version, so try it before the switch. This script runs the same query from 20 concurrent callers through the URL you give it. A pooler that mixes up prepared statements fails it with `prepared statement "s0" already exists` or `prepared statement "s0" does not exist`:

```typescript
// in scripts/check-pooler.ts
// run with: DATABASE_URL="<pooled URL>" npx tsx scripts/check-pooler.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const results = await Promise.allSettled(Array.from({ length: 200 }, (_, i) => prisma.$queryRaw`select ${i}::int as n`));
const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
console.log(`${results.length - failures.length} of ${results.length} queries succeeded`);
for (const message of new Set(failures.map((f) => String(f.reason?.message ?? f.reason).split("\n").pop()))) console.log(message);
await prisma.$disconnect();
process.exit(failures.length ? 1 : 0);
```

With Prisma, a failure means adding `pgbouncer=true` to the URL, which turns prepared statements off.

## Cutover

The order in [cutover.md](../cutover.md) holds on every host. Three steps go wrong the same way everywhere:

- **Scheduled work starts the moment the host creates it.** A cron service, schedule, or cron trigger deployed a week early runs in both apps for that week. Add it in the cutover's "Move scheduled work" step.
- **Your computer isn't on the IP allowlist.** Once enforcement is on, a backfill from a laptop gets `403` errors. Run it on the host.
- **A rollback doesn't undo migrations.** Keep each migration compatible with the release before it, as [environments.md](../environments.md) describes.

## What wasn't verified

Run against Postgres 18.6, PgBouncer 1.25.2 in transaction mode, Valkey 8, and Shopify's React Router template as of October 2026: `db-check.sql`, the URL helper, the worker and its shutdown, the esbuild worker build, the pooled load script, and the pooler check. The Cloudflare Hyperdrive, Supavisor, Neon, and Cloud SQL poolers weren't tested here; their platform files say what was.
