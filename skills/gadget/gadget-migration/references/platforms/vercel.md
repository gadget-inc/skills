# Vercel

## What is this?

Vercel runs each route of the app as a Vercel Function, with Schedules for scheduled actions and a Marketplace database such as Neon. Background actions go to a queue from the Marketplace, such as Inngest, because Vercel Queues and Workflows don't attach to a React Router app. Gadget's guide: https://docs.gadget.dev/guides/moving-to-another-platform/vercel

Read [common.md](common.md) first. For Inngest itself, read [inngest.md](inngest.md).

## Checks to run

```bash
node path/to/skills/gadget-migration/scripts/preflight.ts path/to/new-app --platform vercel
```

| Check | What it catches | How to check by hand |
|---|---|---|
| `vercel/functions-react-router` | A `functions` section in a React Router app. Every key fails the build, even one under `api/` | |
| `vercel/functions-no-match` | A `functions` pattern that matches no file. Next.js builds anyway, and the `maxDuration` applies to nothing | |
| `vercel/schedule-unprotected` | A schedule's `path` route that doesn't check `CRON_SECRET`, in its own code or a file it imports with a relative path. The path is public | |
| `vercel/schedule-method` | A schedule's route that can't take the method Schedules send: `POST` unless `requestMethod` says `GET`. A route written for the older Cron Jobs, which sent `GET`, has only a `loader`. A Pages Router route's default export takes every method | |
| `vercel/schedules-before-cutover` | Schedules in `vercel.json`, which start with the first production deployment that declares them | `vercel schedules list --environment production`: each one should say inactive until the switch |
| `vercel/inngest-max-duration` | The route Inngest calls without a `maxDuration`, so every step stops at 300 seconds | |
| `vercel/webhook-waituntil` | A webhook route that hands its work to `waitUntil`, which never retries | |
| `vercel/pg-pool` | A `pg` pool not registered with `attachDatabasePool` | |
| `vercel/multipart-upload` | File uploads parsed on the server, which stop at 4.5MB | |
| `vercel/deployment-url` | A deployment URL, with a 9-character hash before the team slug as in `my-app-4f9c2a1bc-my-team.vercel.app`, or a `-git-` branch URL, in a `shopify.app*.toml`. A production alias such as `my-app-studio42.vercel.app` passes | |
| `vercel/preview-database` | A build script that runs migrations, which preview builds run too | `vercel env ls`: no `DATABASE_URL` or `DATABASE_URL_UNPOOLED` row may list Production and Preview together |
| `vercel/deployment-protection` | Standard Protection on the staging domain | `curl -s -o /dev/null -w "%{http_code}\n" https://staging.example.com/auth/login` prints the app's `200`, not `401` |

Three more that the script can't see:

- **Function region and database region.** The function region is `iad1` unless `vercel.json` sets `regions`. Neon's console shows the database's, which should be AWS `us-east-1` for `iad1`.
- **Static IPs.** Settings > Networking lists them. Look up each address's ASN with `whois -h whois.cymru.com " -v 203.0.113.10"` for Shopify's allowlist, as [IP allowlists](https://docs.gadget.dev/guides/moving-to-another-platform/vercel#ip-allowlists) describes.
- **Duplicate and late schedule runs.** `vercel schedules executions list prune-audit-logs` lists each run with its execution id.

## Failure signatures

| You see | Cause | Fix |
|---|---|---|
| `` Error: [unused_function] The pattern "app/routes/api.inngest.ts" defined in `functions` doesn't match any Serverless Functions inside the `api` directory. `` | A `functions` section in a React Router app | Delete it and `export const config = { maxDuration: 800 }` from the route ([Check your host's time limits](https://docs.gadget.dev/guides/moving-to-another-platform/vercel#check-your-host-s-time-limits)) |
| `` You made a POST request to "/schedules/reconcile-shops" but did not provide an `action` for route "routes/schedules.reconcile-shops", so there is no way to handle the request. `` and a `405` | The route exports only a `loader`, as routes for Vercel's older Cron Jobs did, and Schedules send `POST` | Export the work as the `action`, or set `"requestMethod": "GET"` on the schedule |
| `504` with `FUNCTION_INVOCATION_TIMEOUT`, at the same point on every retry | The route's function stopped at its maximum duration, 300 seconds by default | Raise `maxDuration` on that route, up to 800 on Pro. For Inngest steps that share one request, see `inngest/max-runtime` in [inngest.md](inngest.md) |
| `Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms` (`P2028`) | A Prisma interactive transaction, such as a scheduled prune, ran past Prisma's 5-second default | Pass `{ timeout }` to `$transaction`, below the route's `maxDuration`, as in the example below |
| `413` with `FUNCTION_PAYLOAD_TOO_LARGE` | An upload over 4.5MB sent to a function | Upload from the browser to storage ([File storage](https://docs.gadget.dev/guides/moving-to-another-platform/vercel#file-storage)) |
| `FATAL: remaining connection slots are reserved` | The app connects with `DATABASE_URL_UNPOOLED`, or idle `pg` pools pile up. A 0.25 CU Neon compute gives you 105 connections | `DATABASE_URL` in the app, and `attachDatabasePool` for your own pools ([Use a connection pooler](https://docs.gadget.dev/guides/moving-to-another-platform/vercel#use-a-connection-pooler)) |
| `Datasource "db": PostgreSQL database "neondb", schema "public" at "<production host>"` in a Preview build's log | The preview build's `prisma migrate deploy` ran against production, because Preview shares Production's `DATABASE_URL` | Neon's preview branching ([Map your models to database tables](https://docs.gadget.dev/guides/moving-to-another-platform/vercel#map-your-models-to-database-tables)) |
| `! The environment argument is deprecated. Use --environment.` | `vercel env add NAME production` | `vercel env add NAME --environment production --sensitive` |
| A nightly job ran twice, both runs with the same `metadata.executionId` | Vercel delivered one run twice, which Schedules allow | Save each execution id in a unique column and skip repeats, as below |

## Complete examples

### `vercel.json` for React Router

React Router routes set their own duration with `export const config = { maxDuration }`, so this file has no `functions` section. This is the file after the cutover's "Move scheduled work" step; until then, deploy it without `schedules`, as [Cutover](#cutover) explains. `vercel build` accepts it, and its output carries both schedules:

```json
// in vercel.json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "regions": ["iad1"],
  "schedules": {
    "prune-audit-logs": { "schedule": "0 2 * * *", "timezone": "UTC", "path": "/schedules/prune-audit-logs" },
    "reconcile-shops": { "schedule": "0 * * * *", "jitter": 5, "path": "/schedules/reconcile-shops", "requestMethod": "POST" }
  }
}
```

The route for each path is the guide's [schedule route](https://docs.gadget.dev/guides/moving-to-another-platform/vercel#replace-scheduled-actions), which checks `CRON_SECRET` and passes `metadata.executionId` on.

### `vercel.json` for Next.js

Next.js routes do take `functions` settings, and a schedule can target a function privately, so its route needs no `CRON_SECRET`. A function target uses the function's output path, `api/schedules/prune-audit-logs`, not the file name:

```json
// in vercel.json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "regions": ["iad1"],
  "functions": {
    "app/api/inngest/route.ts": { "maxDuration": 800 },
    "app/api/schedules/prune-audit-logs/route.ts": { "maxDuration": 300, "experimentalTriggers": [{ "type": "schedule/v1beta" }] }
  },
  "schedules": {
    "prune-audit-logs": { "schedule": "0 2 * * *", "timezone": "UTC", "function": "api/schedules/prune-audit-logs" }
  }
}
```

```typescript
// in app/api/schedules/prune-audit-logs/route.ts
import { handleSchedule } from "@vercel/schedules";
import { pruneAuditLogs } from "../../../services/audit-logs.server";

// the schedule/v1beta trigger makes this function private: only the scheduler can call it
export const POST = handleSchedule(async (metadata) => {
  await pruneAuditLogs(metadata.executionId);
});
```

### The scheduled work, safe to run twice or at once

Vercel can deliver a run twice with the same execution id, can start a run while the last one is still going, and doesn't retry a path target. With Prisma, record each execution id in a table with a unique key, and take a transaction-level advisory lock, which works through Neon's pooler in transaction mode:

```prisma
// in prisma/schema.prisma
model ScheduleRun {
  executionId String   @id @map("execution_id")
  schedule    String
  startedAt   DateTime @default(now()) @map("started_at") @db.Timestamptz(6)

  @@map("schedule_run")
}
```

```typescript
// in app/services/audit-logs.server.ts
import prisma from "../db.server";

// Called with metadata.executionId from the schedule's route. Returns what it did, for the logs.
export async function pruneAuditLogs(executionId: string): Promise<string> {
  return await prisma.$transaction(
    async (tx) => {
      // released at commit, so it works through a pooler in transaction mode
      const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`select pg_try_advisory_xact_lock(hashtextextended('schedule:prune-audit-logs', 0)) as locked`;
      if (!locked) return "skipped: the previous run is still going";

      // a second delivery of the same run inserts nothing. If the delete fails, this insert rolls back with it
      const { count } = await tx.scheduleRun.createMany({ data: [{ executionId, schedule: "prune-audit-logs" }], skipDuplicates: true });
      if (count === 0) return `skipped: run ${executionId} was already delivered`;

      const deleted = await tx.$executeRaw`delete from audit_log where created_at < now() - interval '90 days'`;
      return `deleted ${deleted} audit_log rows`;
    },
    // Prisma ends an interactive transaction after 5 seconds by default. Keep this under the route's maxDuration.
    { timeout: 240_000, maxWait: 10_000 }
  );
}
```

Run through PgBouncer in transaction mode against Postgres 18: two concurrent calls with one execution id deleted the rows once, a third call with that id was skipped, and a call while another session held the lock was skipped. For work that needs Gadget's 5 retries, have the route send an event to your queue instead, with the execution id as the event id.

## Cutover

The order in [cutover.md](../cutover.md) and the guide's [Cut over to the new platform](https://docs.gadget.dev/guides/moving-to-another-platform/vercel#cut-over-to-the-new-platform) holds. On Vercel:

- **Schedules start with the deploy that declares them.** A production schedule is active as soon as a production deployment has it, and keeps an enabled or disabled state across deployments. Add `schedules` in the "Move scheduled work" deploy, or deploy it early and run `vercel schedules disable prune-audit-logs`, then `vercel schedules enable prune-audit-logs` at the switch. Custom environments have their own schedules: `vercel schedules list --environment staging`.
- **Static IPs before the allowlist.** Turn them on, look up their ASN, and add it with the United States for `iad1` before **Allow your new host to call Shopify**.
- **`shopify.app.toml` names the production domain**, never a deployment URL. `vercel/deployment-url` catches it.
- **Rollback.** An Instant Rollback moves the domain and that deployment's schedules back, not your migrations. After it, pushes to the production branch stop going live until `vercel promote <deployment-url>`.

## What wasn't verified

Run with Vercel CLI 65.14.0 and `@vercel/react-router` 1.3.7 on Shopify's React Router template, offline with a hand-written `.vercel/project.json`: `vercel build` with both `vercel.json` files (the Next.js one on Next.js 16.4.6), the `unused_function` error, the `405` from a `loader`-only schedule route, and the `vercel env add` warning. The schedule service ran with Prisma 6.19.3 through PgBouncer 1.25.2 in transaction mode, and the TypeScript blocks typecheck. The `P2028` text and the `Datasource` line come from Prisma against local Postgres.

Nothing ran on a Vercel account, so these come from Vercel's and Neon's documentation and the guide's fact-check: Deployment Protection's response to Shopify and to Inngest, whether a custom environment's domain can be a Deployment Protection Exception, schedule delivery and duplicate runs, `504 FUNCTION_INVOCATION_TIMEOUT`, `413 FUNCTION_PAYLOAD_TOO_LARGE`, Neon's connection numbers, the ASN of Static IPs, and what `vercel env ls` prints for a database shared by Production and Preview.
