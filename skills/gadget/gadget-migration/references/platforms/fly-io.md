# Fly.io

## What is this?

A Fly.io app is a set of Machines, small VMs that run your Docker image, configured by a `fly.toml` with one process group per command: `web`, `worker`, and `cron`. Most of what goes wrong is a `fly.toml` default (`SIGINT`, a 5-second drain, Machines that stop when idle) or a command Fly.io runs for you (`fly launch`). Gadget's guide: https://docs.gadget.dev/guides/moving-to-another-platform/fly-io

For Fly.io itself (flyctl, `fly.toml` keys, secrets, scaling, certificates), load Fly's `fly` skill: `fly skills install` with flyctl 0.5.1 or later, or `npx skills add superfly/skills` (https://github.com/superfly/skills). Don't follow its `fly launch` path on a Shopify app; the first check below says why. This file covers only what breaks or changes because the app came from Gadget.

Read [common.md](common.md) first.

## Checks to run

```bash
node path/to/skills/gadget-migration/scripts/preflight.ts path/to/new-app --platform fly-io
```

It reads every `fly.toml` and `fly.<name>.toml` at the root. Validate each config with `fly config validate --strict -c <file>`; it runs offline with `FLY_API_TOKEN=offline`. See the `fly` skill.

| Check | What it catches | Command when the script can't see it |
|---|---|---|
| `fly-io/launch-rewrote-shopify-toml` | `fly launch` ran its Dockerfile generator, which replaced every `https://` host in `shopify.app.toml` with `<app>.fly.dev` and ran `shopify app deploy` | `shopify app versions list --config shopify.app.toml` shows which URLs Shopify has |
| `fly-io/duplicate-app` | Two configs with the same `app`, so deploying staging replaces production's Machines | |
| `fly-io/kill-signal` | No `kill_signal = "SIGTERM"`, while the worker's or the web server's shutdown handler only listens for `SIGTERM` | |
| `fly-io/kill-timeout` | A worker with the 5-second default drain, or a value over Fly.io's 300 | |
| `fly-io/web-auto-stop` | `auto_stop_machines` that stops web Machines, with or without `min_machines_running` | `fly scale show` should list 2 `web` Machines |
| `fly-io/cron-in-web` | Supercronic in a group that serves HTTP, which runs on 2 Machines | `fly scale show` should list 1 `cron` Machine |
| `fly-io/supercronic-missing` | A `supercronic` process with no Supercronic in the Dockerfile | |
| `fly-io/cron-tz` | `CRON_TZ` on an alpine image without `tzdata` | |
| `fly-io/migrate-on-start` | A `[processes]` command that runs migrations on every start, such as the template's `docker-start` | |
| `fly-io/no-release-command` | Prisma migrations that nothing in the config runs | |
| `fly-io/prisma-generate` | `[processes]` commands that skip the template's `prisma generate`, with no `prisma generate` in the Dockerfile | |
| `fly-io/build-time-variable` | A value the frontend reads through `import.meta.env` set in `[env]`, which the build never sees | |
| `fly-io/build-arg-unused` | A `[build.args]` entry with no `ARG` in the Dockerfile | |
| `fly-io/env-fly-prefix` | An `[env]` name starting with `FLY_`, which Fly.io's reference forbids | |
| `fly-io/web-shutdown` | A Redis connection the web server opens and never closes on `SIGTERM`, with `kill_timeout` over 30 seconds | |
| `fly-io/ioredis-family` | ioredis before 5.8.2 without `family` in its options, which can't resolve Fly.io's IPv6-only private addresses. A warning, because a Redis URL that ends with `?family=6` also fixes it and the script can't see the URL | `fly ssh console -C "node -p 'new URL(process.env.REDIS_URL).search'"` prints `?family=6` when the URL sets it |
| The role the app connects as | `fly-user` owns the tables, so row-level security does nothing for it | `fly ssh console -C "node -p 'new URL(process.env.DATABASE_URL).username'"` prints the user without the password. Then run `scripts/db-check.sql` as that user through `fly mpg proxy <cluster-id>` |
| Postgres version | `fly mpg create` makes Postgres 16 unless told 17, with no in-place upgrade | `psql "$DIRECT_DATABASE_URL" -c "show server_version"` |
| Redis eviction | Upstash with eviction on deletes queued jobs | `fly redis status my-app-queue` should show `Eviction` as `Disabled` |
| Static egress addresses | No fixed outbound address, or fewer pairs than Machines over 64 per region | `fly ips list --app my-app` lists the egress pairs and prints a warning when a region needs more |
| Certificate before DNS | A domain moved from Gadget has no certificate until Fly.io can verify it | `fly certs check app.example.com` shows the certificate as issued before you change DNS |

## Failure signatures

| You see | Cause | Fix |
|---|---|---|
| `unknown time zone America/New_York`, and Supercronic exits | A `CRON_TZ` line on `node:22-alpine`, which has no `/usr/share/zoneinfo` | `apk add --no-cache tzdata` ([Replace scheduled actions](https://docs.gadget.dev/guides/moving-to-another-platform/fly-io#replace-scheduled-actions)) |
| ``The table `public.Session` does not exist in the current database.`` (Prisma `P2021`) | `[processes]` replaced the template's `docker-start`, and there's no `release_command`, so migrations never ran | `release_command = "npx prisma migrate deploy"` under `[deploy]` |
| `@prisma/client did not initialize yet` on every Machine | `[processes]` commands replace the Dockerfile's `CMD` and its `prisma generate` | `RUN npx prisma generate` after `COPY . .` ([Run migrations once per deploy](https://docs.gadget.dev/guides/moving-to-another-platform/fly-io#run-migrations-once-per-deploy)) |
| `[ioredis] Unhandled error event: Error: getaddrinfo ENOTFOUND` followed by the Redis host | ioredis 5.8.1 or older looks up IPv4 only, and the Upstash address is IPv6 | `family: 6`, or ioredis 5.8.2 or later ([Create a Redis database for your queue](https://docs.gadget.dev/guides/moving-to-another-platform/fly-io#create-a-redis-database-for-your-queue)) |
| A worker exits the moment a deploy starts, with status 130 and none of its shutdown log | Fly.io sent `SIGINT`, and the worker only handles `SIGTERM` | `kill_signal = "SIGTERM"` ([Check your host's time limits](https://docs.gadget.dev/guides/moving-to-another-platform/fly-io#check-your-host-s-time-limits)) |
| Each deploy or `fly secrets set` takes about 5 minutes longer per web Machine | The web server closed its HTTP server on `SIGTERM`, and an open Redis connection kept Node running until `kill_timeout` | Close the queue and connection on `SIGTERM` in `app/entry.server.tsx`, as in [common.md](common.md#run-a-bullmq-worker-that-drains-on-deploy) |
| `job stalled more than allowable limit` after two deploys during a long job | `kill_timeout` is 300 seconds at most, and best effort | Split the job, or run it on [a Machine of its own](https://docs.gadget.dev/guides/moving-to-another-platform/fly-io#run-long-actions-on-machines-of-their-own) |
| Every scheduled job runs twice in the same minute | Supercronic runs in a group with `[http_service]`, which gets 2 Machines | A `cron` group of its own |
| The first webhook after a quiet night fails, then Shopify's retry succeeds | `auto_stop_machines = "stop"`, as `fly launch` writes it | `auto_stop_machines = "off"` ([Receive webhooks](https://docs.gadget.dev/guides/moving-to-another-platform/fly-io#receive-webhooks)) |
| `app my-app-staging is in organization my-app-staging, but cluster <id> is in organization my-app-production. They must be in the same organization to attach` | A `fly mpg fork` of production, attached from a staging organization | Copy the data with `pg_dump` through `fly mpg proxy` ([Environments](https://docs.gadget.dev/guides/moving-to-another-platform/fly-io#environments)) |
| `Warning: Your app has 70 machines in region iad but only 1 egress IPv4(s). You need at least 1 more to cover all machines.` | Each static egress pair serves 64 Machines in a region | `fly ips allocate-egress --region iad` again |
| `Service has no processes set but app has 3 processes defined` | `[http_service]` without `processes = ["web"]` | Add it |
| Occasional `ECONNRESET` on queries | Fly.io's proxy closes connections older than 10 minutes when it restarts | Pool lifetime 600 seconds, idle timeout 300 ([Connect through PgBouncer](https://docs.gadget.dev/guides/moving-to-another-platform/fly-io#connect-through-pgbouncer)) |

## Complete examples

These are Shopify's React Router template with Prisma and BullMQ, with the worker and its shutdown from [common.md](common.md#run-a-bullmq-worker-that-drains-on-deploy). Production and staging are separate apps, each with its own database, Redis, and Shopify app. Secrets (`SHOPIFY_API_SECRET`, `DATABASE_URL`, `DIRECT_DATABASE_URL`, `REDIS_URL`) are set with `fly secrets set --stage`, never in these files.

```toml
# in fly.toml
# production: fly deploy
app = "my-app"
primary_region = "iad"

# the worker and web shutdown handlers listen for SIGTERM, and Fly.io sends SIGINT unless this is set
kill_signal = "SIGTERM"
# the most Fly.io waits after the signal before it forces a Machine to stop, as best effort
kill_timeout = 300

[build.args]
  # the frontend reads this through import.meta.env, so the build needs it; [env] exists only at runtime
  VITE_APP_ENV = "production"

[deploy]
  # once per deploy, on a temporary Machine with the app's secrets, before any Machine is updated
  release_command = "npx prisma migrate deploy"
  # the first deploy creates every table; the default is 5 minutes
  release_command_timeout = "15m"

[env]
  APP_ENV = "production"
  PORT = "3000"
  SHOPIFY_APP_URL = "https://app.example.com"
  SHOPIFY_API_KEY = "production-client-id"
  SCOPES = "write_products"

[processes]
  web = "npm run start"
  # node, not npm, so SIGTERM reaches the worker's handler
  worker = "node build/worker.js"
  # add this group in the cutover's "Move scheduled work" deploy, not before
  cron = "supercronic /app/crontab"

[http_service]
  processes = ["web"]
  internal_port = 3000
  force_https = true
  # webhooks never wait for a Machine to boot; fly deploy keeps 2 web Machines
  auto_stop_machines = "off"
  auto_start_machines = true

  [[http_service.checks]]
    grace_period = "10s"
    interval = "15s"
    timeout = "5s"
    method = "GET"
    path = "/healthz"

[[vm]]
  processes = ["web", "worker"]
  cpu_kind = "shared"
  cpus = 1
  memory = "1gb"

[[vm]]
  processes = ["cron"]
  cpu_kind = "shared"
  cpus = 1
  memory = "256mb"
```

`fly.staging.toml` is a copy of `fly.toml`, deployed with `fly deploy --config fly.staging.toml` in the staging organization. It differs in five places:

- `app = "my-app-staging"`.
- `VITE_APP_ENV = "staging"` under `[build.args]`.
- The `[env]` values: `APP_ENV = "staging"`, `SHOPIFY_APP_URL = "https://my-app-staging.fly.dev"`, and the staging Shopify app's `SHOPIFY_API_KEY`.
- The `cron` group is there from day one, because staging's scheduler runs against staging's database.
- One `[[vm]]` with no `processes` line and `memory = "512mb"`, shared by every group.

Everything else stays the same, including `auto_stop_machines = "off"`, so staging tests webhook timing too.

The template's Dockerfile with what the process groups need. Supercronic is checked against the SHA-256 that its v0.2.51 release publishes, for the architecture Docker builds (Fly.io's builders are amd64; a local build on Apple silicon is arm64):

```dockerfile
# in Dockerfile
FROM node:22-alpine
# tzdata: Supercronic exits on a CRON_TZ line without it, and node:22-alpine has none
RUN apk add --no-cache openssl tzdata

ARG TARGETARCH
RUN case "${TARGETARCH:-amd64}" in \
      amd64) sha=cc232108374e8e2b537045f2d5eaa1229f619db314c3ba6a14d38b35dc0aa123 ;; \
      arm64) sha=4ae22576a78223d8ccdf5f3b3660a5cbb5288416bf0ca96afc4a36d195932b94 ;; \
      *) echo "no Supercronic checksum for ${TARGETARCH}"; exit 1 ;; \
    esac \
 && wget -qO /usr/local/bin/supercronic "https://github.com/aptible/supercronic/releases/download/v0.2.51/supercronic-linux-${TARGETARCH:-amd64}" \
 && echo "${sha}  /usr/local/bin/supercronic" | sha256sum -c - \
 && chmod +x /usr/local/bin/supercronic

EXPOSE 3000
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# [build.args] reach the build only through ARG, before the step that reads them
ARG VITE_APP_ENV
# [processes] replace CMD, so the client is generated here instead of in docker-start
RUN npx prisma generate
RUN npm run build

# what docker run starts; fly.toml's [processes] override it
CMD ["npm", "run", "start"]
```

```text
# in crontab
# Supercronic runs these in UTC, because the image sets no time zone. For another zone, put a line
# such as CRON_TZ=America/New_York above the jobs; the Dockerfile installs tzdata for it.
# pruneAuditLogs: adds one job at 02:00 UTC, which the worker runs with the queue's retries
0 2 * * * node /app/build/enqueue-prune-audit-logs.js
```

The cron line runs the guide's [enqueue script](https://docs.gadget.dev/guides/moving-to-another-platform/fly-io#replace-scheduled-actions), compiled. This extends [common.md](common.md#run-a-bullmq-worker-that-drains-on-deploy)'s `build:worker` to bundle both files, with `esbuild` under `dependencies`:

```json
// in package.json
{
  "scripts": {
    "build": "react-router build && npm run build:worker",
    "build:worker": "esbuild worker=app/worker.server.ts enqueue-prune-audit-logs=scripts/enqueue-prune-audit-logs.ts --bundle --platform=node --format=esm --packages=external --outdir=build"
  }
}
```

The health check route that `fly.toml` calls. A Machine that can't reach the database fails it, so the proxy stops sending it webhooks and `fly deploy` stops before it updates the next Machine:

```typescript
// in app/routes/healthz.tsx
import prisma from "../db.server";

export const loader = async () => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // fails inside the check's 5-second timeout, so a hung database fails the check instead of timing it out
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("database check timed out after 3 seconds")), 3000);
  });
  try {
    await Promise.race([prisma.$queryRaw`select 1`, timeout]);
    return new Response("ok", { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("health check failed", error);
    return new Response("database unreachable", { status: 503 });
  } finally {
    clearTimeout(timer);
  }
};
```

Creating one environment, in order. Run it once with `my-app` in the production organization and once with `my-app-staging` in the staging one. Each `--stage` waits for the first deploy instead of restarting Machines:

```bash
fly apps create my-app --org my-app-production          # never fly launch
fly mpg create --name my-app-db --org my-app-production --region iad --pg-major-version 17 --volume-size 20
fly mpg users create <cluster-id> --username my-app --role writer
fly mpg attach <cluster-id> --app my-app --username my-app   # DATABASE_URL, through PgBouncer, as a user that doesn't own the tables
fly secrets set --app my-app --stage DIRECT_DATABASE_URL="<direct URL for fly-user from the cluster's Connect tab>"
fly redis create --name my-app-queue --org my-app-production --region iad --no-replicas --disable-eviction
fly secrets set --app my-app --stage REDIS_URL="<the URL it printed>" SHOPIFY_API_SECRET="<from the Partner Dashboard>"
fly ips allocate-egress --app my-app --region iad
fly certs setup app.example.com --app my-app            # add the _acme-challenge CNAME it prints before the DNS change
```

`--volume-size` is above the size of the exported records, because Fly.io's import guide says a load bigger than the starting volume fails.

## Cutover

The order in [cutover.md](../cutover.md) and the guide's [cutover section](https://docs.gadget.dev/guides/moving-to-another-platform/fly-io#cut-over-to-the-new-platform) holds. On Fly.io:

- **The `cron` group starts with the deploy that adds it.** Leave `cron` out of `[processes]` until the "Move scheduled work" step, then deploy and check `fly scale show` lists exactly 1 `cron` Machine.
- **Drain time is at most 300 seconds.** A job running when the deploy starts gets `SIGTERM` and up to 5 minutes. Web Machines should stop in well under a second; a deploy that pauses about 5 minutes on each web Machine means the Redis connection is still open.
- **Load records through `fly mpg proxy`**, which reaches Postgres directly, not PgBouncer, as the [load script](https://docs.gadget.dev/guides/moving-to-another-platform/fly-io#load-your-records) needs.
- **Run `shopify app deploy` yourself** once `fly certs check` shows the certificate issued and both web Machines pass `/healthz`.
- **Rollback:** `fly releases --image` lists each release's image, and `fly deploy --image <image>` deploys one. Its `release_command` runs from that older image: with Prisma 6.19.3, `prisma migrate deploy` with fewer migrations than the database has prints `No pending migrations to apply` and exits 0, so it doesn't block the rollback, and it doesn't undo anything either.

## What wasn't verified

No Fly.io account was used, so nothing was deployed, and the commands in the checks table that talk to Fly.io (`fly ssh console`, `fly redis status`, `fly ips list`, `fly scale show`) weren't run. Run locally on 10 November 2026:

- `fly.toml` passes `fly config validate --strict` with flyctl 0.5.7 and a fake token, which runs flyctl's own validation without the API. The `Service has no processes set` error in the failure table is flyctl's output from that run.
- The Dockerfile, crontab, and `build:worker` script were built with Docker on `node:22-alpine` (arm64), and `supercronic -test` passed on the crontab, with and without a `CRON_TZ` line. Without `tzdata`, `supercronic -test` printed `unknown time zone`. The amd64 Supercronic download was built under emulation; Fly.io's remote builders weren't tried.
- With the tests in `tests/gadget-migration/platforms-fly-io`: a web server with common.md's queue module was still running 5 seconds after `SIGTERM`, and exited in about 230 ms with common.md's handler, but not on `SIGINT`. A worker under `npm run` that only handles `SIGTERM` died at once on `SIGINT`. ioredis 5.8.1 failed with `getaddrinfo ENOTFOUND` on an IPv6-only Docker network, not Upstash, and connected with `family: 6`.
- The `P2021` error and the rollback's `release_command` came from Prisma 6.19.3 on Postgres 18.6.

From flyctl's source at the same commit, not run against the API: that `release_command` runs on the deployed image, the `fly mpg attach` error, the egress warning, and `fly launch` rewriting `shopify.app.toml` (in `@flydotio/dockerfile` 0.7.15, `fly.js`). From Fly.io's docs and the guide's fact-check only: the Writer role's grants and whether it bypasses row-level security, the 5-second default and 300-second maximum for `kill_timeout`, that `[env]` names can't start with `FLY_`, and the 64 Machines per egress pair.
