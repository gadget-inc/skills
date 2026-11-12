// Flexible Server's database pitfalls on a local Postgres 17 and PgBouncer 1.26.1, the version Azure runs.
// myadmin stands in for the server's admin user: LOGIN, CREATEDB, CREATEROLE, a member of azure_pg_admin, and
// not a superuser, as Microsoft lists it, with BYPASSRLS, which Microsoft's docs imply on PostgreSQL 16 and later. Backs azure/owner-skips-rls and
// azure/pgbouncer-prepared. Needs Docker. Run with: npm test (from this folder)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { PrismaClient } from "@prisma/client";
import { skillDir } from "../platform-blocks.ts";
import { docker, hasImage, PGBOUNCER_IMAGE, POSTGRES_IMAGE, removeContainer, waitFor } from "./docker.ts";

const NET = "migcheck-azure-net";
const PG = "migcheck-azure-pg";
const BOUNCER_OFF = "migcheck-azure-bouncer-0";
const BOUNCER_ON = "migcheck-azure-bouncer-200";
const PG_PORT = 57682;
const OFF_PORT = 57683;
const ON_PORT = 57684;
const skip = hasImage(POSTGRES_IMAGE) && hasImage(PGBOUNCER_IMAGE) ? false : `needs Docker with ${POSTGRES_IMAGE} and ${PGBOUNCER_IMAGE}`;

const url = (user: string, password: string, port = PG_PORT, extra = "") => `postgresql://${user}:${password}@127.0.0.1:${port}/shopify_app${extra}`;
const ADMIN = url("myadmin", "admin-password");
const APP = url("app_user", "a-long-random-password");

async function as<T>(connectionString: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// scripts/db-check.sql through psql inside the Postgres container, as the given role
function dbCheck(user: string, password: string): string {
  const sql = readFileSync(`${skillDir}scripts/db-check.sql`, "utf8");
  const run = spawnSync("docker", ["exec", "-i", "-e", `PGPASSWORD=${password}`, PG, "psql", "-h", "127.0.0.1", "-U", user, "-d", "shopify_app", "-X", "-f", "-"], { input: sql, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

function startBouncer(name: string, port: number, maxPrepared: number) {
  removeContainer(name);
  docker(
    "run", "-d", "--name", name, "--network", NET, "-p", `127.0.0.1:${port}:5432`,
    "-e", `DB_HOST=${PG}`, "-e", "DB_PORT=5432", "-e", "DB_USER=app_user", "-e", "DB_PASSWORD=a-long-random-password",
    "-e", "AUTH_TYPE=scram-sha-256", "-e", "POOL_MODE=transaction", "-e", "DEFAULT_POOL_SIZE=2",
    "-e", `MAX_PREPARED_STATEMENTS=${maxPrepared}`, "-e", "LISTEN_PORT=5432",
    PGBOUNCER_IMAGE
  );
}

before(async () => {
  if (skip) return;
  for (const name of [BOUNCER_OFF, BOUNCER_ON, PG]) removeContainer(name);
  spawnSync("docker", ["network", "create", NET], { stdio: "ignore" });
  docker("run", "-d", "--name", PG, "--network", NET, "-p", `127.0.0.1:${PG_PORT}:5432`, "-e", "POSTGRES_PASSWORD=postgres", POSTGRES_IMAGE);
  await waitFor(`postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/postgres`);
  await as(`postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/postgres`, async (c) => {
    await c.query("create role azure_pg_admin nologin");
    await c.query("create role myadmin login password 'admin-password' createdb createrole nosuperuser bypassrls in role azure_pg_admin");
    await c.query("create database shopify_app owner myadmin");
  });
  // the migrations, run as the admin user, which then owns the tables
  await as(ADMIN, async (c) => {
    await c.query('create table "Session" ("id" text primary key, "shop" text not null)');
    await c.query("create table audit_log (id bigserial primary key, shop_id bigint not null, message text not null)");
    await c.query("alter table audit_log enable row level security");
    await c.query("create policy audit_log_shop_isolation on audit_log using (shop_id = current_setting('app.shop_id')::bigint)");
    await c.query("insert into audit_log (shop_id, message) values (1, 'a'), (1, 'b'), (2, 'c')");
    // the guide's app_user, word for word
    await c.query("create role app_user login password 'a-long-random-password' nobypassrls");
    await c.query("grant select, insert, update, delete on all tables in schema public to app_user");
    await c.query("grant usage on all sequences in schema public to app_user");
    await c.query("alter default privileges for role myadmin in schema public grant select, insert, update, delete on tables to app_user");
    await c.query("alter default privileges for role myadmin in schema public grant usage on sequences to app_user");
  });
  startBouncer(BOUNCER_OFF, OFF_PORT, 0);
  startBouncer(BOUNCER_ON, ON_PORT, 200);
  await waitFor(url("app_user", "a-long-random-password", OFF_PORT));
  await waitFor(url("app_user", "a-long-random-password", ON_PORT));
});

after(() => {
  if (skip) return;
  for (const name of [BOUNCER_OFF, BOUNCER_ON, PG]) removeContainer(name);
  spawnSync("docker", ["network", "rm", NET], { stdio: "ignore" });
});

describe("the admin user and row-level security", { skip }, () => {
  it("lets the admin user read every store's rows, and db-check.sql reports both reasons", async () => {
    const rows = await as(ADMIN, async (c) => (await c.query("select count(*)::int as n from audit_log")).rows[0].n);
    assert.equal(rows, 3);
    const report = dbCheck("myadmin", "admin-password");
    assert.match(report, /owns tables with row-level security\s+\| problem/);
    assert.match(report, /role bypasses row-level security\s+\| problem/);
  });

  it("gives app_user one store's rows, and an error with no store set, and db-check.sql passes it", async () => {
    await as(APP, async (c) => {
      await assert.rejects(c.query("select * from audit_log"), /unrecognized configuration parameter "app.shop_id"/);
      await c.query("begin");
      await c.query("select set_config('app.shop_id', '1', true)");
      assert.equal((await c.query("select count(*)::int as n from audit_log")).rows[0].n, 2);
      await c.query("commit");
      // the same connection after a transaction set the store: the setting is now an empty string
      await assert.rejects(c.query("select * from audit_log"), /invalid input syntax for type bigint: ""/);
    });
    const report = dbCheck("app_user", "a-long-random-password");
    assert.doesNotMatch(report, /\| problem \|/);
  });

  it("covers a table a later migration creates as myadmin, through the default privileges", async () => {
    await as(ADMIN, (c) => c.query("create table widget (id bigserial primary key, name text)"));
    await as(APP, async (c) => {
      await c.query("insert into widget (name) values ('w')");
      assert.equal((await c.query("select count(*)::int as n from widget")).rows[0].n, 1);
    });
  });
});

describe("Prisma through PgBouncer in transaction mode", { skip }, () => {
  // 300 queries at once through a client pool of 10 that shares 2 server connections
  async function run(connectionString: string) {
    const prisma = new PrismaClient({ datasources: { db: { url: connectionString } } });
    try {
      const results = await Promise.allSettled(Array.from({ length: 300 }, (_, i) => prisma.session.findMany({ where: { shop: `shop-${i % 7}.myshopify.com` } })));
      const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      // Prisma wraps the Postgres error in its own text, with the quotes escaped
      const reason = (f: PromiseRejectedResult) => {
        const text = String(f.reason?.message ?? f.reason);
        const m = /prepared statement \\?"(\w+)\\?" (does not exist|already exists)/.exec(text);
        return m ? `prepared statement "${m[1]}" ${m[2]}` : text.slice(0, 300);
      };
      return { ok: results.length - failed.length, errors: [...new Set(failed.map(reason))] };
    } finally {
      await prisma.$disconnect();
    }
  }

  it("fails about half the queries with max_prepared_statements at 0, Flexible Server's default", async () => {
    const { ok, errors } = await run(url("app_user", "a-long-random-password", OFF_PORT, "?connection_limit=10"));
    console.log(`max_prepared_statements 0: ${ok} of 300 succeeded; ${errors.join("; ")}`);
    assert.ok(ok < 300, "every query succeeded, so the setting didn't matter");
    assert.ok(errors.some((e) => /prepared statement "s\d+" (does not exist|already exists)/.test(e)), errors.join("\n"));
  });

  it("runs every query with pgbouncer=true in the URL, or with max_prepared_statements at 200", async () => {
    const withFlag = await run(url("app_user", "a-long-random-password", OFF_PORT, "?connection_limit=10&pgbouncer=true"));
    assert.deepEqual(withFlag, { ok: 300, errors: [] });
    const raised = await run(url("app_user", "a-long-random-password", ON_PORT, "?connection_limit=10"));
    assert.deepEqual(raised, { ok: 300, errors: [] });
  });
});
