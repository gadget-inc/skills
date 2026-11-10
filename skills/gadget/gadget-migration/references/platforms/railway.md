# Railway

## What is this?

Railway runs each part of the app as a service in a project with one or more environments, described in `.railway/railway.ts`. Its defaults are the trap: 0 seconds of draining on every deploy, a Redis that saves a snapshot once a minute at most, and a Postgres user that skips row-level security. Gadget's guide: https://docs.gadget.dev/guides/moving-to-another-platform/railway

Read [common.md](common.md) first.

## Checks to run

```bash
node path/to/skills/gadget-migration/scripts/preflight.ts path/to/new-app --platform railway
```

| Check | What it catches | How to check by hand |
|---|---|---|
| `railway/draining` | A web or worker service with no `drainingSeconds`, so `SIGKILL` follows `SIGTERM` at once | **Settings** > **Deploy** > **Draining Seconds**, or a `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` variable |
| `railway/pnpm-start` | A start command through pnpm, which didn't pass `SIGTERM` on in a test | |
| `railway/migrate-on-start`, `railway/prisma-generate` | A start command that migrates on every replica, or one that skips the template's `docker-start` with no `prisma generate` in the Dockerfile | |
| `railway/health-check`, `railway/serverless` | A service with a domain and no health check, or with `sleepApplication: true` | The service's Serverless setting is off |
| `railway/cron-interval`, `railway/cron-before-cutover` | A schedule with runs under 5 minutes apart, and every cron service, which runs once it's applied | `railway cron list --service prune-audit-logs` shows no `SKIPPED` runs |
| `railway/superuser-url` | The app's `DATABASE_URL` set to the template's URL while migrations create row-level security policies | `railway ssh --service web -- node -e 'new (require("@prisma/client").PrismaClient)().$queryRawUnsafe("select current_user").then((r) => { console.log(r); process.exit(0) })'` prints `app_user`, not `postgres` |
| `railway/direct-url-pooler`, `railway/private-domain-url` | Prisma's `directUrl` variable set to `DATABASE_URL`, which PgBouncer takes over, and a URL built from `RAILWAY_PRIVATE_DOMAIN`, which PgBouncer and high availability don't update | The database's **Config** page shows whether Connection Pooling or high availability is on |
| `railway/unknown-reference`, `railway/public-domain-scheme` | A `${{Name.VAR}}` reference to a service the file doesn't define (such as `Postgres` for `postgres`), and a URL variable set to the bare `RAILWAY_PUBLIC_DOMAIN` | `railway variable list --service web --kv` shows the resolved values |
| `railway/redis-persistence` | BullMQ with a Redis that isn't the file's `redis()` helper: the dashboard's Redis template writes no append-only file | `railway connect redis`, then `CONFIG GET appendonly` prints `yes` |
| `railway/ioredis-family` | A Redis connection with no `family`, on ioredis older than 5.8.2 | |
| `railway/config-apply` | Every `.railway/railway.ts`: an apply deletes resources the file leaves out | `railway config plan --verbose`, then read every destructive line |
| `railway/config-as-code` | `railway.json` or `railway.toml`, which new services ignore and old ones stop reading on 1 December 2026 | |
| `railway/bucket-name`, `railway/presign-expiry` | `RAILWAY_BUCKET_NAME` used as the S3 bucket, and `expiresIn` over 7 days | |
| `railway/smtp` | nodemailer on a plan that may block SMTP | The workspace's plan is Pro |
| `railway/config-unreadable` | A `.railway/railway.ts` with no `service(...)` calls the script can read | |

Run `db-check.sql` through the URL the app uses, as [common.md](common.md) says. On Railway, open a tunnel with `railway connect postgres --tunnel-only` and connect as `app_user` with its own password, because the tunnel prints the template user's URL.

## Failure signatures

| You see | Cause | Fix |
|---|---|---|
| The queue is empty after Railway redeploys or moves Redis, with no error | The Redis template saves a snapshot at most once a minute, and the default draining time sends `SIGKILL` at once | The append-only switch below, in that order |
| Redis comes back with 0 keys right after you add `--appendonly yes` to its start command | Redis started with no append-only file and loaded it instead of the snapshot | Remove the flag and redeploy before anything writes, so it loads the snapshot. Then run `CONFIG SET appendonly yes` first ([Keep queued jobs](https://docs.gadget.dev/guides/moving-to-another-platform/railway#keep-queued-jobs-through-a-redis-restart)) |
| `Error: P1002` with `Timed out trying to acquire a postgres advisory lock (SELECT pg_advisory_lock(72707369))` in the pre-deploy log | `DIRECT_DATABASE_URL` still points at the database's `DATABASE_URL`, which PgBouncer took over, and an earlier migration left Prisma's lock on a pooled connection | `DIRECT_DATABASE_URL=${{postgres.DATABASE_UNPOOLED_URL}}`, then `select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and objid = 72707369` |
| `getaddrinfo ENOTFOUND redis.railway.internal` | ioredis older than 5.8.2 asks for IPv4 only, and the environment, created before 16 October 2025, resolves private names to IPv6 only | `family: 0` on the connection, or ioredis 5.8.2 or later |
| `SKIPPED` for every run in `railway cron list` | One run never exited, usually an open Redis or database connection, and Railway never stops it | Close connections at the end of the script, then stop the stuck run |
| `502 Bad Gateway` on the first webhook after a quiet period | Serverless put the web service to sleep | Turn Serverless off ([Receive webhooks](https://docs.gadget.dev/guides/moving-to-another-platform/railway#receive-webhooks)) |
| `Signature version 4 presigned URLs must have an expiration date less than one week in the future` | `expiresIn` over 604800 seconds. Railway allows 90 days, the AWS SDK 7 | Sign for 7 days or less, and store a redirect route's URL, as below |
| A custom domain answers `404` after its `CNAME` resolves | No `TXT` record proving you own the domain | Add the `TXT` record from the domain's settings ([Email and custom domains](https://docs.gadget.dev/guides/moving-to-another-platform/railway#email-and-custom-domains)) |

## Complete examples

### Switch Redis to the append-only file

For Redis added from the dashboard. Order matters: `CONFIG SET` writes the file from the data in memory, and a restart with the flag but no file starts empty.

```bash
railway connect redis
# in the redis-cli it opens:
CONFIG SET appendonly yes
INFO persistence
# repeat INFO persistence until it shows aof_rewrite_in_progress:0 and aof_last_bgrewrite_status:ok
```

Then add `--appendonly yes` to the start command in the Redis service's **Settings** > **Deploy**, as the guide shows. Against `redis:8.2` with the template's flags, 1,000 BullMQ jobs survived a `SIGKILL` this way, and 1,000 more added a second before another `SIGKILL` survived too.

### The project file, with staging and the gaps closed

This is the guide's file, with its domain port and `PORT=3000`, plus four changes: staging gets its own domain; the worker starts with `node`, so any package manager works; the cron service and the switch to `DATABASE_UNPOOLED_URL` each wait for a constant you flip at the right step; and the web service gets the bucket's variables. `ctx.environment` is the environment you linked with `railway link`, such as `staging`.

```typescript
// in .railway/railway.ts
import { bucket, defineRailway, github, postgres, preserve, project, redis, ref, service } from "railway/iac";

// set to true in the cutover's Move scheduled work step: a cron service runs as soon as it's applied
const SCHEDULED_WORK_MOVED = false;
// set to true once the database's Connection Pooling is on, which points its DATABASE_URL at PgBouncer
const POOLED = false;

export default defineRailway((ctx) => {
  const production = ctx.environment === "production";
  const region = "us-east4-eqdc4a"; // Virginia
  const source = github("my-org/my-app");

  const db = postgres("postgres", { region });
  const queue = redis("redis", { region });
  const files = bucket("files", { region: "iad" });

  const env = {
    // app_user from shop-tenancy.md, which row-level security applies to; the template's postgres user skips it
    DATABASE_URL: "postgresql://app_user:${{shared.APP_DB_PASSWORD}}@${{postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/${{postgres.PGDATABASE}}",
    // migrations, as the template's user, which owns the tables
    DIRECT_DATABASE_URL: POOLED ? ref(db, "DATABASE_UNPOOLED_URL") : db.env.DATABASE_URL,
    REDIS_URL: queue.env.REDIS_URL,
    APP_ENV: ctx.environment ?? "development",
    // shared variables with each environment's own Shopify app, created before the first apply
    SHOPIFY_API_KEY: ctx.shared.SHOPIFY_API_KEY,
    SHOPIFY_APP_URL: ctx.shared.SHOPIFY_APP_URL,
    SCOPES: ctx.shared.SCOPES,
    // sealed in the dashboard; preserve() keeps the value instead of clearing it
    SHOPIFY_API_SECRET: preserve(),
  };

  const web = service("web", {
    source,
    start: "npm run start",
    preDeploy: "npx prisma migrate deploy",
    healthcheck: "/healthz",
    replicas: { [region]: production ? 2 : 1 },
    domains: [{ domain: production ? "app.example.com" : "staging.example.com", port: 3000 }],
    // finish webhook requests in progress; give a migration 30 minutes before the deploy fails
    deploy: { drainingSeconds: 30, preDeployTimeoutSeconds: 1800 },
    env: {
      ...env,
      PORT: "3000",
      BUCKET: ref(files, "BUCKET"),
      ENDPOINT: ref(files, "ENDPOINT"),
      REGION: ref(files, "REGION"),
      ACCESS_KEY_ID: ref(files, "ACCESS_KEY_ID"),
      SECRET_ACCESS_KEY: ref(files, "SECRET_ACCESS_KEY"),
    },
  });

  const worker = service("worker", {
    source,
    // compiled by npm run build, as in common.md
    start: "node build/worker.js",
    replicas: { [region]: 1 },
    // longer than the 12-minute job, so a deploy lets it finish
    deploy: { drainingSeconds: 900 },
    env,
  });

  const scheduled = SCHEDULED_WORK_MOVED
    ? [
        service("prune-audit-logs", {
          source,
          start: "node build/enqueue-prune-audit-logs.js",
          replicas: { [region]: 1 },
          deploy: { cronSchedule: "0 2 * * *" },
          env: { REDIS_URL: queue.env.REDIS_URL },
        }),
      ]
    : [];

  return project("my-app", { resources: [db, queue, files, web, worker, ...scheduled] });
});
```

`railway config plan --environment staging` previews staging. Staging needs its own shared variables with its own Shopify app, and Railway doesn't copy sealed variables when it duplicates an environment, so seal `SHOPIFY_API_SECRET` there again. When `POOLED` becomes true, change the host and port in `DATABASE_URL` to those in the database's new `DATABASE_URL` as well.

### Public file URLs from a private bucket

Gadget gave a public file field a URL that never expires. Railway buckets are private, and the AWS SDK signs a URL for 7 days at most, so a presigned URL stored in a Shopify metafield or an email breaks within a week. Store `https://app.example.com/files/<key>` instead, and let a route sign a fresh URL on each request. Upload and private download helpers are in [files-and-storage.md](../files-and-storage.md); this is the client they need on Railway, with the AWS SDK, for example:

```typescript
// in app/services/bucket.server.ts
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// the bucket's variables: BUCKET is the name the S3 API takes, not RAILWAY_BUCKET_NAME
export const s3 = new S3Client({
  endpoint: process.env.ENDPOINT, // https://t3.storageapi.dev
  region: process.env.REGION,
  credentials: { accessKeyId: process.env.ACCESS_KEY_ID!, secretAccessKey: process.env.SECRET_ACCESS_KEY! },
  // older buckets need path-style URLs; the bucket's Credentials tab says which
  forcePathStyle: process.env.BUCKET_PATH_STYLE === "true",
  // keeps checksum parameters, such as x-amz-checksum-mode=ENABLED, out of presigned URLs
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

export function signedGetUrl(key: string, expiresIn = 60 * 60) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.BUCKET!, Key: key }), { expiresIn });
}
```

```typescript
// in app/routes/files.$.tsx
import { signedGetUrl } from "../services/bucket.server";

// only keys under this prefix were public files on Gadget; the rest need a permission check first
const PUBLIC_PREFIX = "public/";
const SIGNED_FOR = 60 * 60;

export async function loader({ params }: { params: Record<string, string | undefined> }) {
  const key = params["*"] ?? "";
  if (!key.startsWith(PUBLIC_PREFIX) || key.split("/").some((part) => part === "" || part === "..")) {
    return new Response("Not found", { status: 404 });
  }
  const url = await signedGetUrl(key, SIGNED_FOR);
  // a cache keeps the redirect for less time than the signature lasts
  return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": `public, max-age=${SIGNED_FOR - 300}` } });
}
```

## Cutover

The order in [cutover.md](../cutover.md) holds. On Railway, per [Cut over to the new platform](https://docs.gadget.dev/guides/moving-to-another-platform/railway#cut-over-to-the-new-platform):

- **Before the day:** the Redis switch above, and `drainingSeconds` on the web and worker. Both take effect on the next deploy, not during the cutover.
- **Backfill:** add one job per store to your queue so the worker runs it on Railway. `railway run` runs on your computer, which Shopify's allowlist rejects with `403`.
- **Move scheduled work:** set `SCHEDULED_WORK_MOVED = true`, run `railway config plan`, check it adds only the cron service, and apply.
- **Before `shopify app deploy`:** the domain shows a green check, the web service passed its health check, and Serverless is off.
- **Rolling back:** a rollback restores an older image and its variables, within 72 hours on Hobby and 120 on Pro. Migrations stay applied ([Moving back](../cutover.md#moving-back)).

## What wasn't verified

Run locally: the project file typechecked with TypeScript 5.9.3 against `railway` 3.16.0 and evaluated for production and staging with the package's own functions; the append-only switch, its wrong order, and the way back on `redis:8.2` (8.2.11) with the template's start command and BullMQ 6.7.3; `railwayapp/redis:8.2`, the `redis()` helper's image, under `linux/amd64` emulation (`appendonly yes`, `noeviction`, no `docker-entrypoint.sh`); the bucket client and route against the AWS SDK 3.1165.0, offline; the `P1002` lock through PgBouncer 1.25.2, the version of Railway's pgbouncer image; `ENOTFOUND` for an IPv6-only name in a `node:22-slim` container; and ioredis's default `family` from 5.3.2 to 6.0.0.

Not run, because they need a Railway account: `railway config plan` and `apply` (the IaC engine ships in the CLI and needs a linked project), whether a bucket's variables resolve through `ref(files, "BUCKET")`, the port Railway injects as `PORT` for a domain, whether an apply deletes a PgBouncer service or recovery bucket the file leaves out, and the CLI commands above (their flags come from `railway --help` in CLI 5.71.0). pnpm not passing `SIGTERM` on is the guide's test, not this file's. That new services ignore `railway.json`, the 90-day bucket limit, the `RAILWAY_BUCKET_NAME` warning, Hobby blocking SMTP, Serverless `502`s, and the `TXT` record come from Railway's docs and the guide's fact-check.
