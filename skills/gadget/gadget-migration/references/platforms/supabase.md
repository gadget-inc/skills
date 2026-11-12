# Supabase

## What is this?

Supabase is Postgres with sign-in, file storage, realtime updates, a queue (pgmq), a scheduler (pg_cron), and an HTTPS API built from your tables (the Data API). It runs no long-lived Node server, so the app server and job workers still need a Node host. Most failures are in the database: tables the publishable key can read, a server role that skips every policy or can't see pgvector, and cron jobs that start too early and hide their failures.

For Supabase itself (the CLI, Data API grants, policies, Postgres practice), load Supabase's `supabase` and `supabase-postgres-best-practices` skills: `npx skills add supabase/agent-skills` (https://github.com/supabase/agent-skills). This file covers only what breaks or changes because the app came from Gadget.

Read [common.md](common.md) first.

## Checks to run

```bash
# reads supabase/migrations and Prisma's migrations in file name order, config.toml, env examples, scripts, CI files, and Edge Functions
node path/to/skills/gadget-migration/scripts/preflight.ts path/to/new-app --platform supabase
```

| Check | What it catches |
|---|---|
| `supabase/rls-missing` | A table in an exposed schema with neither row-level security nor a revoke from both `anon` and `authenticated`. Prisma's `Session` table is the worst case: it holds every store's access token |
| `supabase/policy-without-role`, `supabase/policy-user-metadata` | `create policy` with no `to`, so it applies to the Data API roles too (an error with `using (true)`), and a policy that reads `user_metadata`, which each user can change |
| `supabase/view-security-invoker` | A view or materialized view over a table with row-level security, without `security_invoker` |
| `supabase/vector-grant` | pgvector in `extensions` and a login role without `usage` on that schema or `extensions` in its `search_path` |
| `supabase/cron-in-migration`, `supabase/cron-http`, `supabase/cron-history` | `cron.schedule` in a migration, which starts the job on deploy and on every branch; `net.http_post` in a job, whose failures are recorded as `succeeded`; nothing pruning `cron.job_run_details` |
| `supabase/prisma-pgbouncer`, `supabase/server-url-postgres` | A port `6543` URL without `pgbouncer=true` in an app that uses Prisma, and a server URL in an env example that signs in as `postgres` while the migrations use row-level security |
| `supabase/db-push-local` | `supabase db push` without `--remote` in package scripts, CI, or shell scripts |
| `supabase/edge-function-shopify` | An Edge Function that calls Shopify's Admin API, which the IP allowlist will block |
| `supabase/storage-sql-delete` | `delete from storage.objects` or `storage.buckets` |
| `supabase/import-email-confirm` | `auth.admin.createUser` with `password_hash` and no `email_confirm` |

The script can't see the hosted project, and says so as `supabase/data-api-grants`. Run these against each environment as `postgres`, then `scripts/db-check.sql` as `app_server`, as [common.md](common.md#checks-to-run) describes:

```sql
-- in scripts/data-api-exposure.sql
-- every row is a table or view the publishable key (anon) or any signed-up user (authenticated) can read
select c.relname, c.relkind, c.relrowsecurity as rls,
  coalesce(c.reloptions::text[] && array['security_invoker=true', 'security_invoker=on', 'security_invoker=1'], false) as security_invoker
from pg_class c
where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm')
  and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select'))
order by c.relname;
```

| What | Command or place |
|---|---|
| Direct connection reachable from the host | `dig +short A db.<project-ref>.supabase.co` prints nothing when it's IPv6 only. From the host, `psql "$DIRECT_DATABASE_URL" -c 'select 1'` |
| Failed cron runs, and failed `pg_net` calls (kept 6 hours) | `select j.jobname, d.status, d.return_message, d.start_time from cron.job_run_details d join cron.job j using (jobid) where d.status <> 'succeeded' order by d.start_time desc limit 20;` and `select id, status_code, error_msg, created from net._http_response where error_msg is not null or status_code >= 400 order by id desc;` |
| Messages read more than once | `select msg_id, read_ct, enqueued_at, vt from pgmq.q_external where read_ct > 1;` and `select * from pgmq.metrics('external');` |
| Room to load | `select pg_size_pretty(pg_database_size(current_database()));`, the disk size in **Database Settings**, and the Spend Cap in the organization's billing settings |

## Failure signatures

| You see | Cause | Fix |
|---|---|---|
| `operator does not exist: extensions.vector <=> unknown`, `type "vector" does not exist`, or `permission denied for schema extensions` | The server's role doesn't search `extensions`, or has no usage on it (the last). Migrations, run as `postgres`, work | `grant usage on schema extensions to app_server;` and `alter role app_server set search_path = "$user", public, extensions;` ([Map your models](https://docs.gadget.dev/guides/moving-to-another-platform/supabase#map-your-models-to-database-tables)) |
| `(ENOIDENTIFIER) no tenant identifier provided (external_id or sni_hostname required)`, or `(ENOTFOUND) tenant/user app_server.abcd not found` | A user name through the shared pooler without `.<project-ref>`, or with the wrong one | `app_server.<project-ref>`, with the ref from the **Connect** dialog ([Policies for your server](https://docs.gadget.dev/guides/moving-to-another-platform/supabase#policies-for-your-server)) |
| `(EAUTHQUERY) unsupported or invalid secret format` through the pooler, or `password authentication failed for user "app_server"` directly and once the pooler has cached an older password | The role has no password: never set, or wiped by `supabase db reset` or a restored backup. Or the password is wrong | Run `scripts/set-role-password.ts` below |
| `prepared statement "s1" does not exist` | Prisma through port `6543` without `pgbouncer=true` | Add it ([Connect to your database](https://docs.gadget.dev/guides/moving-to-another-platform/supabase#connect-to-your-database)) |
| `connect ENETUNREACH 2600:1f18:...:5432 - Local (:::0)` | The direct connection is IPv6 only and the host has no IPv6 | The shared pooler, or the IPv4 add-on |
| `curl .../rest/v1/Session?select=shop,accessToken -H "apikey: sb_publishable_..."` returns tokens | A table created as `postgres` got the project's default grants for `anon` | `revoke all on "Session" from anon, authenticated;` ([Rewrite permissions](https://docs.gadget.dev/guides/moving-to-another-platform/supabase#rewrite-permissions-and-shop-tenancy)) |
| 0 rows for the server, or `[]` from the Data API, and no error | Row-level security is on and no policy names that role | A policy `to app_server`, such as `using (true)` for a table no store owns |
| A view returns every store's rows while `app.shop_id` is one store | The view runs as `postgres`, which has `BYPASSRLS` | `with (security_invoker = true)` |
| `permission denied for table audit_log` as `app_server` | The table was created before the default privileges migration, or by another role | `grant select, insert, update, delete on audit_log to app_server;` |
| `relation "pgmq.q_external" does not exist` | The queue was made in the dashboard of another environment or branch | `select pgmq.create('external');` in a migration |
| `permission denied for table q_reports`, or `permission denied for sequence q_external_msg_id_seq` from `pgmq.metrics` | A queue created after the grants, with no default privileges; or no grant on pgmq's sequences | The queue migration below |
| `succeeded` and `1 row` in `cron.job_run_details` while nothing happened | `net.http_post` only queues the request. `net._http_response` has `Could not connect to server` | Queue a pgmq message instead ([Replace scheduled actions](https://docs.gadget.dev/guides/moving-to-another-platform/supabase#replace-scheduled-actions)) |
| A message with `read_ct` 2 while its first run is still going | Its visibility timeout ended mid-job | Renew it while the job runs, as the worker below does |
| `Direct deletion from storage tables is not allowed. Use the Storage API instead.` | SQL against `storage.objects` | `storage.from(bucket).remove([path])` |
| `ID must conform to the uuid v4 format` | A Gadget id passed as `id` to `createUser` | Put it in `app_metadata.gadget_id` |
| `Email not confirmed` | Imported without `email_confirm` | `email_confirm: user.emailVerified`, which Gadget's sign-in already required |
| `Invalid login credentials` for an imported user with the right password | The hash went in `password`, so it became the password | `password_hash` |
| `Error creating user` (500) | `password_hash` isn't a bcrypt hash, such as the whole `password` object | `user.password?.hash` |
| `Target: local stack (127.0.0.1:54322)`, then `connect ECONNREFUSED` | `supabase db push` without `--remote` on CLI 3 | `supabase db push --remote` |
| `cannot execute INSERT in a read-only transaction` | The disk filled, and Supabase made the database read-only (from Supabase's docs) | Raise the disk, and check that the Spend Cap lets it grow, before the load ([Load your records](https://docs.gadget.dev/guides/moving-to-another-platform/supabase#load-your-records)) |

## Complete examples

### A migration set for a Shopify app

These run in order with `supabase db push --remote`, on every branch, and on `supabase db reset`. The server connects as `app_server`, and migrations keep running as `postgres`.

```sql
-- in supabase/migrations/20261109000000_app_server_role.sql
-- no BYPASSRLS and owns no tables, so every policy applies; scripts/set-role-password.ts sets its password
create role app_server with login;
grant usage on schema public to app_server;
alter default privileges for role postgres in schema public grant select, insert, update, delete on tables to app_server;
alter default privileges for role postgres in schema public grant usage on sequences to app_server;
-- pgvector's types and operators live in the extensions schema
grant usage on schema extensions to app_server;
alter role app_server set search_path = "$user", public, extensions;
-- tables created after this get no Data API grants, whatever the project's default
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
```

```sql
-- in supabase/migrations/20261109000100_tables.sql
create extension if not exists vector with schema extensions;
create extension if not exists pgmq;
create extension if not exists pg_cron with schema pg_catalog;
create table audit_log (
  id bigint generated by default as identity primary key,
  shop_id bigint not null,
  event text not null,
  created_at timestamptz not null default now()
);
create table widget (
  id bigint generated by default as identity primary key,
  shop_id bigint not null,
  name text not null,
  embedding vector(1536),
  updated_at timestamptz not null default now()
);
create index widget_embedding_idx on widget using hnsw (embedding vector_cosine_ops);

alter table audit_log enable row level security;
alter table widget enable row level security;
revoke all on audit_log, widget from anon, authenticated;
create policy audit_log_shop_isolation on audit_log to app_server
  using (shop_id = current_setting('app.shop_id')::bigint);
create policy widget_shop_isolation on widget to app_server
  using (shop_id = current_setting('app.shop_id')::bigint);
-- security_invoker applies app_server's policies instead of those of the owner, postgres
create view widget_count_by_shop with (security_invoker = true) as
  select shop_id, count(*) as widgets from widget group by shop_id;

select pgmq.create('external');
select pgmq.create('scheduled');
grant usage on schema pgmq to app_server;
grant select, insert, update, delete on all tables in schema pgmq to app_server;
grant select on all sequences in schema pgmq to app_server; -- pgmq.metrics reads them
-- queues that later migrations create
alter default privileges for role postgres in schema pgmq grant select, insert, update, delete on tables to app_server;
alter default privileges for role postgres in schema pgmq grant select on sequences to app_server;
```

If Prisma Migrate creates the template's `Session` table, lock it in a migration made after your init one with `npx prisma migrate dev --create-only --name lock_session`, so it sorts after the table. Revoke rather than enable row-level security: with no policy for `app_server`, session storage finds nothing and every request signs the merchant in again.

```sql
-- in prisma/migrations/<timestamp>_lock_session/migration.sql
REVOKE ALL ON "Session" FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Session" TO app_server;
```

Cron jobs go in a file you run per environment at the cutover, not in a migration. `cron.schedule` with an existing name replaces that job, so running the file twice leaves two jobs, not four:

```sql
-- in supabase/cron/schedule.sql
-- run with: psql "$DIRECT_DATABASE_URL" -f supabase/cron/schedule.sql
-- one message a night; the worker retries it, which pg_cron never does
select cron.schedule('enqueue-prune-audit-logs', '0 2 * * *', $$ select pgmq.send('scheduled', '{"job": "pruneAuditLogs"}') $$);
-- pg_cron keeps a row per run forever
select cron.schedule('prune-cron-history', '30 3 * * *', $$ delete from cron.job_run_details where end_time < now() - interval '7 days' $$);
```

pg_cron's one copy at a time then covers only the `pgmq.send`, and a second worker can read the next message while a long run still goes. Take the transaction-level advisory lock from [background-jobs.md](../background-jobs.md#scheduled-actions) in the handler that reads `scheduled`.

### Set the server role's password per environment

The guide sets the password with `\password app_server`, which sends only a SCRAM hash, because Supabase's Postgres image logs every `alter role` statement. This script does the same without an interactive `psql`, for CI or each new environment: it sends a SCRAM verifier, checks that the role signs in through the pooler URL you give it, and prints the server's URL for your host's secrets. Run it in each environment, and again after `supabase db reset` or restoring a backup, which both leave the role without a password.

```typescript
// in scripts/set-role-password.ts
// run with: ADMIN_DATABASE_URL="<direct or session URL as postgres>" POOLER_URL="postgres://app_server.<project-ref>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true" \
//   node scripts/set-role-password.ts | <your host's secrets import, such as fly secrets import>
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import pg from "pg";
// what Postgres stores for a SCRAM-SHA-256 password, built here so the password never reaches the server
function scramVerifier(password: string, iterations = 4096): string {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const storedKey = createHash("sha256").update(createHmac("sha256", salted).update("Client Key").digest()).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

const url = new URL(process.env.POOLER_URL!);
const role = decodeURIComponent(url.username).split(".")[0];
const password = randomBytes(24).toString("base64url"); // ASCII, which SCRAM takes as is, and safe in a URL
const admin = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL });
await admin.connect();
await admin.query(`alter role ${admin.escapeIdentifier(role)} with password ${admin.escapeLiteral(scramVerifier(password))}`);
await admin.end();
url.password = password;
const check = new pg.Client({ connectionString: url.toString() });
await check.connect(); // fails here with the pooler's error if the user name or project ref is wrong
const { rows } = await check.query("select current_user");
await check.end();
console.error(`signed in as ${rows[0].current_user}`);
console.log(`DATABASE_URL=${url}`);
```

### A pgmq worker that drains on deploy

The guide's loop has no shutdown and hides each message for 15 minutes, so a crashed worker's message waits that long. This worker hides a message for 60 seconds and renews the timeout while the job runs, so the 12-minute action is never read twice, and a killed worker's message comes back within a minute. Like pgmq itself, it has no per-store limit or dedupe. With node-postgres:

```typescript
// in app/queue/pgmq-worker.server.ts
import type { Pool } from "pg";
type Message<T> = { msg_id: string; read_ct: number; message: T };

export function startWorker<T>(pool: Pool, queue: string, handle: (message: T) => Promise<void>, options: { concurrency?: number; maxAttempts?: number; visibility?: number; backoff?: (attempt: number) => number } = {}) {
  // 7 attempts with 1, 2, 4, ... second waits, like Gadget's default of 6 retries
  const { concurrency = 1, maxAttempts = 7, visibility = 60, backoff = (attempt: number) => Math.min(2 ** (attempt - 1), 900) } = options;
  const setVt = (id: string, seconds: number) => pool.query("select pgmq.set_vt($1, $2::bigint, $3::int)", [queue, id, seconds]);
  let stopping = false;
  async function run(msg: Message<T>) {
    let renewing: Promise<unknown> = Promise.resolve();
    const renew = setInterval(() => (renewing = setVt(msg.msg_id, visibility).catch(() => {})), (visibility * 1000) / 3);
    const failed = await handle(msg.message).then(() => false, (error) => (console.error(`${queue} message ${msg.msg_id} failed on attempt ${msg.read_ct}`, error), true));
    clearInterval(renew);
    await renewing; // so a late renewal can't undo the backoff below
    if (!failed) await pool.query("select pgmq.delete($1, $2::bigint)", [queue, msg.msg_id]);
    else if (msg.read_ct >= maxAttempts) await pool.query("select pgmq.archive($1, $2::bigint)", [queue, msg.msg_id]); // to pgmq.a_<queue>
    else await setVt(msg.msg_id, backoff(msg.read_ct));
  }
  async function loop() {
    while (!stopping) {
      try {
        // one message at a time, waiting up to 5 seconds for it
        const { rows } = await pool.query<Message<T>>("select msg_id, read_ct, message from pgmq.read_with_poll($1, $2, 1, 5)", [queue, visibility]);
        for (const msg of rows) await run(msg);
      } catch (error) {
        console.error(`${queue} worker: ${(error as Error).message}`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
  const loops = Array.from({ length: concurrency }, loop);
  // stops reading, and resolves when the running jobs have finished
  return { stop: async () => void ((stopping = true), await Promise.all(loops)) };
}
```

```typescript
// in app/worker.server.ts
// start it with node and a bundled file, as common.md shows, so SIGTERM reaches it
import pg from "pg";
import { startWorker } from "./queue/pgmq-worker.server";
import { notifyExternalSystem } from "./services/external.server";

// app_server through the transaction pooler is fine: every call is one statement
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const worker = startWorker<{ orderId: string }>(pool, "external", (m) => notifyExternalSystem(m.orderId), { concurrency: 2 });

let closing: Promise<void> | undefined;
const shutdown = (signal: string) => (closing ??= (async () => {
  console.log(`${signal}: reading no new messages, exiting after the running ones finish`);
  await worker.stop();
  await pool.end();
  process.exit(0);
})());
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
```

### Check the user import

Run the guide's [import script](https://docs.gadget.dev/guides/moving-to-another-platform/supabase#move-app-users-and-sessions) once, after writes to Gadget stop, as in the "Cutover without Shopify" section of [non-shopify-apps.md](../non-shopify-apps.md#cutover-without-shopify), then this. The import writes each user's `gadget_id` and roles into `app_metadata`, which the policies read. A second run skips users who exist, so a user imported earlier keeps that export's password hash and roles, and `updateUserById` with a new `password_hash` doesn't change the password either. Delete users you imported to test before the final run. This script finds exported users with no Supabase user, users Gadget had verified who can't sign in, and signs one user in with the publishable key, the way the browser will:

```typescript
// in scripts/verify-users.ts
// run with: VERIFY_EMAIL=<a user whose Gadget password you know> VERIFY_PASSWORD=... node scripts/verify-users.ts
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const options = { auth: { persistSession: false } };
const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, options);
const exported = readFileSync("user.ndjson", "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const imported = new Map<string, boolean>(); // gadget_id -> email confirmed
for (let page = 1; ; page++) {
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
  if (error) throw error;
  for (const u of data.users) if (u.app_metadata.gadget_id) imported.set(String(u.app_metadata.gadget_id), Boolean(u.email_confirmed_at));
  if (data.users.length < 1000) break;
}
const missing = exported.filter((u) => !imported.has(String(u.id))).map((u) => u.id);
const unconfirmed = exported.filter((u) => u.emailVerified && imported.get(String(u.id)) === false).map((u) => u.id);
console.log(`${exported.length} exported, ${missing.length} missing, ${unconfirmed.length} verified in Gadget but unconfirmed here`);
if (missing.length) console.log(`missing: ${missing.slice(0, 50).join(", ")}`);
const browser = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, options);
const { data, error } = await browser.auth.signInWithPassword({ email: process.env.VERIFY_EMAIL!, password: process.env.VERIFY_PASSWORD! });
if (error) throw new Error(`sign-in failed: ${error.code} ${error.message}`);
const claims = JSON.parse(Buffer.from(data.session.access_token.split(".")[1], "base64url").toString());
console.log(`signed in; the token carries gadget_id ${claims.app_metadata?.gadget_id}`);
process.exit(missing.length || unconfirmed.length ? 1 : 0);
```

## Cutover

The order in [cutover.md](../cutover.md) and the guide's [cutover section](https://docs.gadget.dev/guides/moving-to-another-platform/supabase#cut-over-to-the-new-platform) holds. On Supabase:

- **Before the day:** `supabase db push --remote` creates the tables, queues, and role, and starts nothing. Run `scripts/set-role-password.ts` in production, deploy the server and workers, and run `scripts/data-api-exposure.sql`, which should print no rows.
- **Load your custom models:** check that the Spend Cap lets the disk grow, raise the disk, add your address to the network restrictions, and load over the direct URL or the session pooler, never port `6543`. Remove your address afterward.
- **Move scheduled work:** run `supabase/cron/schedule.sql` in production in the same minute you turn off Gadget's scheduler triggers, then check `select jobname, schedule, active from cron.job;`. To roll back, `select cron.unschedule('enqueue-prune-audit-logs');` before Gadget's scheduler runs again, or both apps run the job.
- **Deploys during the move:** give the worker a drain time above your longest job, 12 minutes for the action that runs that long. Messages stay in pgmq through a deploy, and a killed worker's message is read again within the 60-second timeout.

## What wasn't verified

Run on the Supabase CLI 3.1.0 local stack in November 2026: Postgres image `17.11.0.018`, Supavisor 2.10.0, GoTrue v2.197.0, PostgREST, storage-api v1.90.1, pgmq 1.5.1, pg_cron 1.6.4, pg_net, supabase-js 2.119.0, and Prisma 6.19.3. The migration set, the exposure query, the role password script, the worker and its shutdown, and the import check run in `tests/gadget-migration/platforms-supabase`. Every failure signature was reproduced there except the one marked "from Supabase's docs" (its text is Postgres's own, seen with `default_transaction_read_only`), and `connect ENETUNREACH`, which came from a Docker container with no IPv6. Not checked, because they need a hosted project: whether hosted Supavisor prints the same `ENOIDENTIFIER`, `ENOTFOUND`, and `EAUTHQUERY` text as 2.10.0, IPv6-only DNS, the Spend Cap and disk growth, read-only mode, a restored backup dropping role passwords (seen only after `supabase db reset`), `log_statement` on hosted projects, dashboard paths, Edge Function limits and egress, Realtime, and cron jobs running on preview branches. Those come from the guide and its fact-check.
