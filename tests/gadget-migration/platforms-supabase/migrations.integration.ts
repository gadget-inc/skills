// Applies the migration set in references/platforms/supabase.md, in order, to Supabase's Postgres
// image, then checks what app_server, anon, and authenticated can see. Also runs the role password
// script, the cron file, the Prisma Session lock, and the Data API exposure query.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { MIGRATIONS, dockerSkip, logs, sql, startSupabasePostgres, stopSupabasePostgres, testDir, urlFor, writeBlocks } from "./helpers.ts";

const NAME = "migcheck-supabase-migrations";
const PORT = 57441;
const skip = dockerSkip();
let adminUrl: string;
let admin: pg.Pool;
let server: pg.Pool;
let serverUrl: string;
let scriptOutput: { stdout: string; stderr: string };

// a 1536-dimension embedding with the given leading values
const vec = (...head: number[]) => `[${[...head, ...Array(1536 - head.length).fill(0)].join(",")}]`;

async function withShop<T>(pool: pg.Pool, shopId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.shop_id', $1, true)", [shopId]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

// runs fn as one of the Data API roles, the way PostgREST does with set role
async function asRole<T>(role: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await admin.connect();
  try {
    await client.query("begin");
    await client.query(`set local role ${role}`);
    return await fn(client);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

before(async () => {
  if (skip) return;
  adminUrl = await startSupabasePostgres(NAME, PORT);
  admin = new pg.Pool({ connectionString: adminUrl, max: 4 });
  for (const path of MIGRATIONS) await admin.query(sql(path));

  // the password script, run as the reference shows, against the direct connection
  const dir = writeBlocks(join(testDir, ".typecheck/run-migrations"), ["scripts/set-role-password.ts"]);
  const out = execFileSync(process.execPath, [join(dir, "scripts/set-role-password.ts")], {
    encoding: "utf8",
    env: { ...process.env, ADMIN_DATABASE_URL: adminUrl, POOLER_URL: `postgres://app_server@127.0.0.1:${PORT}/postgres` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  scriptOutput = { stdout: out, stderr: "" };
  serverUrl = out.trim().replace(/^DATABASE_URL=/, "");
  server = new pg.Pool({ connectionString: serverUrl, max: 4 });

  await admin.query(`
    insert into audit_log (shop_id, event) values (111, 'orderCreated'), (222, 'orderCreated'), (222, 'orderPaid');
    insert into widget (shop_id, name, embedding) values
      (222, 'same direction', '${vec(1)}'),
      (111, 'other store', '${vec(1)}'),
      (222, 'right angle', '${vec(0, 1)}');
  `);
});

after(async () => {
  await server?.end();
  await admin?.end();
  if (!skip) stopSupabasePostgres(NAME);
});

describe("supabase.md migration set on Supabase's Postgres image", () => {
  it("prints a working URL, and the Postgres log has the SCRAM verifier, not the password", async (t) => {
    if (skip) return t.skip(skip);
    const password = new URL(serverUrl).password;
    assert.match(password, /^[A-Za-z0-9_-]{32}$/);
    const { rows } = await server.query("select current_user, rolbypassrls from pg_roles where rolname = current_user");
    assert.deepEqual(rows, [{ current_user: "app_server", rolbypassrls: false }]);
    const log = logs(NAME);
    // the image logs every DDL statement
    assert.match(log, /statement: alter role "app_server" with password 'SCRAM-SHA-256\$4096:/);
    assert.ok(!log.includes(password));
    assert.equal(scriptOutput.stdout.split("\n").filter(Boolean).length, 1);
  });

  it("lets app_server read one store's rows, including through the view", async (t) => {
    if (skip) return t.skip(skip);
    const result = await withShop(server, "222", async (c) => ({
      events: (await c.query("select event from audit_log order by id")).rows.map((r) => r.event),
      widgets: (await c.query("select name from widget order by id")).rows.map((r) => r.name),
      counts: (await c.query("select shop_id::text, widgets::int from widget_count_by_shop")).rows,
    }));
    assert.deepEqual(result, { events: ["orderCreated", "orderPaid"], widgets: ["same direction", "right angle"], counts: [{ shop_id: "222", widgets: 2 }] });
  });

  it("fails a query with no store set, and a write for another store", async (t) => {
    if (skip) return t.skip(skip);
    // a fresh connection never had the setting; a pooled one had it set by an earlier transaction
    await assert.rejects(server.query("select count(*) from audit_log"), /unrecognized configuration parameter "app.shop_id"|invalid input syntax for type bigint: ""/);
    await assert.rejects(
      withShop(server, "222", (c) => c.query("insert into audit_log (shop_id, event) values (111, 'forged')")),
      /new row violates row-level security policy for table "audit_log"/
    );
  });

  it("runs a vector similarity query as app_server", async (t) => {
    if (skip) return t.skip(skip);
    const { rows } = await withShop(server, "222", (c) => c.query(`select name from widget order by embedding <=> '${vec(0.9, 0.1)}' limit 1`));
    assert.deepEqual(rows, [{ name: "same direction" }]);
    // and with the vector as a query parameter, as an ORM sends it
    const param = await withShop(server, "222", (c) => c.query("select name from widget order by embedding <=> $1::vector limit 1", [vec(0, 1)]));
    assert.deepEqual(param.rows, [{ name: "right angle" }]);
  });

  it("gives anon and authenticated nothing", async (t) => {
    if (skip) return t.skip(skip);
    for (const role of ["anon", "authenticated"]) {
      for (const table of ["audit_log", "widget", "widget_count_by_shop"]) {
        await assert.rejects(asRole(role, (c) => c.query(`select * from ${table}`)), new RegExp(`permission denied for (table|view) ${table}`));
      }
    }
  });

  it("covers a table a later migration adds: app_server gets grants and the Data API roles don't", async (t) => {
    if (skip) return t.skip(skip);
    await admin.query("create table later_table (id bigint primary key)");
    const { rows } = await admin.query(`select has_table_privilege('app_server', 'later_table', 'select') as server,
      has_table_privilege('anon', 'later_table', 'select') as anon, has_table_privilege('authenticated', 'later_table', 'select') as authenticated`);
    assert.deepEqual(rows, [{ server: true, anon: false, authenticated: false }]);
  });

  it("reproduces the failures the migration set avoids", async (t) => {
    if (skip) return t.skip(skip);
    // the guide's original role: grants on public only
    await admin.query("create role guide_server with login password 'guide'; grant usage on schema public to guide_server; grant select on widget to guide_server");
    const guide = new pg.Client({ connectionString: urlFor(adminUrl, "guide_server", "guide") });
    await guide.connect();
    await assert.rejects(guide.query(`select id from widget order by embedding <=> '${vec(1)}' limit 1`), /operator does not exist: extensions\.vector <=> unknown/);
    await assert.rejects(guide.query("select id from widget order by embedding operator(extensions.<=>) '[1]' limit 1"), /permission denied for schema extensions/);
    await assert.rejects(guide.query(`select '${vec(1)}'::vector`), /type "vector" does not exist/);
    await guide.end();

    // a view without security_invoker reads as its owner, postgres
    await admin.query("create view widget_count_unsafe as select shop_id, count(*) as widgets from widget group by shop_id");
    const leaked = await withShop(server, "222", (c) => c.query("select shop_id::text from widget_count_unsafe order by 1"));
    assert.deepEqual(leaked.rows.map((r) => r.shop_id), ["111", "222"]);

    // row-level security with no policy for app_server: 0 rows, no error
    await admin.query("create table no_policy (shop_id bigint); alter table no_policy enable row level security; insert into no_policy values (222)");
    const empty = await withShop(server, "222", (c) => c.query("select count(*)::int as n from no_policy"));
    assert.deepEqual(empty.rows, [{ n: 0 }]);
  });

  it("lets app_server use the queues, including one created later", async (t) => {
    if (skip) return t.skip(skip);
    await server.query(`select pgmq.send('external', '{"orderId": "11"}')`);
    const { rows } = await server.query("select msg_id, read_ct, message from pgmq.read('external', 30, 1)");
    assert.deepEqual(rows[0].message, { orderId: "11" });
    await server.query("select pgmq.archive('external', $1::bigint)", [rows[0].msg_id]);
    const metrics = await server.query("select queue_length::int from pgmq.metrics('external')");
    assert.deepEqual(metrics.rows, [{ queue_length: 0 }]);

    await admin.query("select pgmq.create('reports')");
    await server.query(`select pgmq.send('reports', '{}')`);

    // without the default privileges, a later queue is closed to app_server
    await admin.query("alter default privileges for role postgres in schema pgmq revoke all on tables from app_server");
    await admin.query("select pgmq.create('unreachable')");
    await assert.rejects(server.query(`select pgmq.send('unreachable', '{}')`), /permission denied for table q_unreachable/);
    await assert.rejects(server.query(`select pgmq.send('missing', '{}')`), /relation "pgmq\.q_missing" does not exist/);
    await assert.rejects(server.query("select cron.schedule('x', '* * * * *', 'select 1')"), /permission denied for schema cron/);
  });

  it("schedules the cron file's jobs once, however often it runs, and their commands work", async (t) => {
    if (skip) return t.skip(skip);
    await admin.query(sql("supabase/cron/schedule.sql"));
    await admin.query(sql("supabase/cron/schedule.sql"));
    const { rows } = await admin.query("select jobname, schedule, command from cron.job order by jobname");
    assert.deepEqual(rows.map((r) => [r.jobname, r.schedule]), [["enqueue-prune-audit-logs", "0 2 * * *"], ["prune-cron-history", "30 3 * * *"]]);
    for (const row of rows) await admin.query(row.command);
    const message = await admin.query("select message from pgmq.read('scheduled', 30, 1)");
    assert.deepEqual(message.rows, [{ message: { job: "pruneAuditLogs" } }]);
  });

  it("locks the template's Session table to the server", async (t) => {
    if (skip) return t.skip(skip);
    const template = readFileSync(join(testDir, "prisma/session-migration.sql"), "utf8");
    await admin.query(template);
    // what an older project's default grants, or a table made before the role migration, gives it
    await admin.query(`grant all on "Session" to anon, authenticated`);
    await admin.query(sql("prisma/migrations/20261109000000_lock_session/migration.sql"));
    const { rows } = await admin.query(`select has_table_privilege('anon', '"Session"', 'select') as anon,
      has_table_privilege('authenticated', '"Session"', 'select') as authenticated, has_table_privilege('app_server', '"Session"', 'insert') as server`);
    assert.deepEqual(rows, [{ anon: false, authenticated: false, server: true }]);
  });

  it("finds no exposed table for the migration set, and finds one that is", async (t) => {
    if (skip) return t.skip(skip);
    const query = sql("scripts/data-api-exposure.sql");
    // later tests in this file added tables; only explicit grants expose them
    assert.deepEqual((await admin.query(query)).rows, []);
    await admin.query("create table leaky (id bigint); grant select on leaky to anon");
    await admin.query("create view leaky_view as select * from widget; grant select on leaky_view to authenticated");
    const { rows } = await admin.query(query);
    assert.deepEqual(rows, [
      { relname: "leaky", relkind: "r", rls: false, security_invoker: false },
      { relname: "leaky_view", relkind: "v", rls: false, security_invoker: false },
    ]);
  });
});
