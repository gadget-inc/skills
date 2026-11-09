// Runs the snippets in references/shop-tenancy.md, references/background-jobs.md, and
// references/actions-and-transactions.md against Postgres, PgBouncer, and Redis. See tests/README.md.
// This is the only file that creates the app_user and storefront_user roles.
//
// Optional extras:
// - PGBOUNCER_BIN=/path/to/pgbouncer runs the pooler tests. The file starts its own PgBouncer in
//   transaction mode on PGBOUNCER_PORT (default 64352) in front of DATABASE_URL.
// - `npm install --no-save drizzle-orm` runs the Drizzle test.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { DATABASE_URL, redisConnection, scratchDatabase, skipWithoutDatabase as skip, skipWithoutRedis } from "./db.ts";
import { blocks, importBlock, sql } from "./snippets.ts";

const DATABASE = "gadget_migration_tenancy_test";

let admin: pg.Pool; // superuser, owns the tables
let app: pg.Pool; // app_user, subject to row-level security
let appUrl: string;
let storefrontUrl: string;

before(async () => {
  if (skip) return;
  const bootstrap = new pg.Client({ connectionString: DATABASE_URL });
  await bootstrap.connect();
  try {
    await bootstrap.query(`drop database if exists ${DATABASE}`);
    // these fail if the role still holds privileges in another database on this server
    await bootstrap.query("drop role if exists app_user");
    await bootstrap.query("drop role if exists storefront_user");
  } finally {
    await bootstrap.end();
  }

  const scratch = await scratchDatabase(DATABASE);
  admin = scratch.admin;
  await admin.query(`
    create table audit_log (id bigserial primary key, shop_id bigint not null, event text not null, order_id bigint, created_at timestamptz not null default now());
    insert into audit_log (shop_id, event) values (1, 'a'), (1, 'b'), (2, 'c'), (3, 'd');
  `);
  await admin.query(sql("shop-tenancy.md", "db/migrations/shop_isolation.sql"));
  await admin.query(sql("shop-tenancy.md", "db/migrations/app_role.sql"));

  // Created after app_role.sql, so app_user reaches these only through the default privileges.
  await admin.query(sql("actions-and-transactions.md", "db/migrations/outbox.sql"));
  await admin.query(`
    create table customer_note (id bigserial primary key, shop_id bigint not null, customer_id bigint not null, body text not null);
    alter table customer_note enable row level security;
    alter table customer_note force row level security;
    create policy customer_note_shop_isolation on customer_note using (shop_id = current_setting('app.shop_id')::bigint);
    insert into customer_note (shop_id, customer_id, body) values (1, 10, 'ten'), (1, 11, 'eleven'), (2, 10, 'other shop');
  `);
  await admin.query(sql("shop-tenancy.md", "db/migrations/customer_isolation.sql"));

  scratch.url.username = "app_user";
  scratch.url.password = "change-me";
  appUrl = scratch.url.toString();
  scratch.url.username = "storefront_user";
  storefrontUrl = scratch.url.toString();
  app = new pg.Pool({ connectionString: appUrl, max: 1 }); // one connection, so reuse is observable
});

after(async () => {
  await app?.end();
  await admin?.end();
});

const pgWithShop = () => importBlock(blocks("shop-tenancy.md", "app/db/withShop.server.ts").find((block) => block.includes('from "pg"'))!);
const prismaWithShop = () => importBlock(blocks("shop-tenancy.md", "app/db/withShop.server.ts").find((block) => block.includes("@prisma/client"))!);
const events = (rows: any[]) => rows.map((row) => row.event);

let drizzleUrl: string | undefined;
try {
  drizzleUrl = import.meta.resolve("drizzle-orm");
} catch {
  // not installed: the Drizzle test is skipped
}

describe("shop-tenancy.md", { skip }, () => {
  it("withShop (node-postgres) returns only the current store's rows", async () => {
    const { withShop } = await pgWithShop();
    const rows = await withShop(app, 1n, async (client: pg.PoolClient) => (await client.query("select event from audit_log order by id")).rows);
    assert.deepEqual(events(rows), ["a", "b"]);
  });

  it("rejects an insert with another store's shop_id", async () => {
    const { withShop } = await pgWithShop();
    await assert.rejects(
      withShop(app, 1n, (client: pg.PoolClient) => client.query("insert into audit_log (shop_id, event) values (2, 'forged')")),
      /new row violates row-level security policy/
    );
  });

  it("rejects an update that moves a row to another store", async () => {
    const { withShop } = await pgWithShop();
    await assert.rejects(
      withShop(app, 1n, (client: pg.PoolClient) => client.query("update audit_log set shop_id = 2 where event = 'a'")),
      /new row violates row-level security policy/
    );
  });

  it("changes 0 rows, without an error, for an update or delete aimed at another store's row", async () => {
    const { withShop } = await pgWithShop();
    const otherStoresRow = (await admin.query("select id from audit_log where event = 'c'")).rows[0].id;
    const counts = await withShop(app, 1n, async (client: pg.PoolClient) => [
      (await client.query("update audit_log set event = 'changed' where id = $1", [otherStoresRow])).rowCount,
      (await client.query("delete from audit_log where id = $1", [otherStoresRow])).rowCount,
    ]);
    assert.deepEqual(counts, [0, 0]);
    assert.equal((await admin.query("select event from audit_log where id = $1", [otherStoresRow])).rows[0].event, "c");
  });

  it("fails a query on a connection that never set the store", async () => {
    const fresh = new pg.Client({ connectionString: appUrl });
    await fresh.connect();
    await assert.rejects(fresh.query("select * from audit_log"), /unrecognized configuration parameter "app.shop_id"/);
    await fresh.end();
  });

  it("fails a query on a pooled connection after an earlier transaction set the store", async () => {
    const { withShop } = await pgWithShop();
    await withShop(app, 1n, (client: pg.PoolClient) => client.query("select 1"));
    await assert.rejects(app.query("select * from audit_log"), /invalid input syntax for type bigint: ""/);
  });

  it("leaks the store into the next request when set_config's third argument is false", async () => {
    const client = await app.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.shop_id', '2', false)");
      await client.query("commit");
      const { rows } = await client.query("select event from audit_log");
      assert.deepEqual(events(rows), ["c"]); // the next request on this connection sees store 2
    } finally {
      await client.query("select set_config('app.shop_id', '', false)");
      client.release();
    }
  });

  it("is skipped entirely for a superuser connection", async () => {
    const { rows } = await admin.query("select count(*)::int as count from audit_log");
    assert.equal(rows[0].count, 4);
  });

  it("is skipped for the table's owner until the table has force row level security", async () => {
    await admin.query(`
      create table owned_by_app (shop_id bigint not null);
      insert into owned_by_app values (1), (2);
      alter table owned_by_app owner to app_user;
      alter table owned_by_app enable row level security;
      create policy owned_by_app_shop_isolation on owned_by_app using (shop_id = current_setting('app.shop_id')::bigint);
    `);
    const owner = new pg.Client({ connectionString: appUrl });
    await owner.connect();
    try {
      assert.equal((await owner.query("select count(*)::int as count from owned_by_app")).rows[0].count, 2); // both stores
      await admin.query("alter table owned_by_app force row level security");
      await assert.rejects(owner.query("select count(*) from owned_by_app"), /unrecognized configuration parameter "app.shop_id"/);
    } finally {
      await owner.end();
    }
  });

  it("gives app_user access to tables created after app_role.sql ran, through the default privileges", async () => {
    await app.query("insert into outbox (job_name, payload) values ('probe', '{}')"); // table and sequence
    assert.equal((await app.query("delete from outbox where job_name = 'probe'")).rowCount, 1);
  });

  it("the pitfall query lists tables that have a shop_id column and no policy", async () => {
    const markdown = readFileSync(new URL("../../../skills/gadget/gadget-migration/references/shop-tenancy.md", import.meta.url), "utf8");
    const query = /no policy: `(select c\.table_name[^`]+)`/.exec(markdown)?.[1];
    assert.ok(query, "the query is still in the pitfalls list");
    await admin.query("create table unprotected (shop_id bigint not null)");
    const { rows } = await admin.query(query);
    assert.deepEqual(rows.map((row) => row.table_name), ["unprotected"]);
  });

  it("withShop (Prisma) returns only the current store's rows", async () => {
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient({ datasourceUrl: appUrl });
    try {
      const { withShop } = await prismaWithShop();
      const logs = await withShop(prisma, 2n, (tx: any) => tx.auditLog.findMany());
      assert.deepEqual(events(logs), ["c"]);
      await assert.rejects(prisma.auditLog.findMany(), /unrecognized configuration parameter|invalid input syntax/);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("withShop (Drizzle) returns only the current store's rows", { skip: !drizzleUrl && "npm install --no-save drizzle-orm" }, async () => {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { sql: query } = await import("drizzle-orm");
    const source = sql("shop-tenancy.md", "app/db/withShop.drizzle.server.ts").replace('from "drizzle-orm"', `from "${drizzleUrl}"`);
    const { withShop } = await importBlock(source);
    const pool = new pg.Pool({ connectionString: appUrl, max: 1 });
    try {
      const db = drizzle(pool);
      const result = await withShop(db, 2n, (tx: any) => tx.execute(query`select event from audit_log`));
      assert.deepEqual(events(result.rows), ["c"]);
      // Drizzle wraps the Postgres error, so look at the cause too
      await assert.rejects(db.execute(query`select event from audit_log`), (error: any) =>
        /unrecognized configuration parameter|invalid input syntax/.test(`${error.message} ${error.cause?.message}`)
      );
    } finally {
      await pool.end();
    }
  });

  it("the restrictive customer policy narrows a storefront request to one customer inside the store", async () => {
    const storefront = new pg.Client({ connectionString: storefrontUrl });
    await storefront.connect();
    try {
      await storefront.query("begin");
      await storefront.query("select set_config('app.shop_id', '1', true), set_config('app.customer_id', '10', true)");
      assert.deepEqual((await storefront.query("select body from customer_note")).rows, [{ body: "ten" }]);
      await storefront.query("commit");

      // with the store set but no customer, the query fails instead of returning the whole store
      await storefront.query("begin");
      await storefront.query("select set_config('app.shop_id', '1', true)");
      await assert.rejects(storefront.query("select body from customer_note"), /app\.customer_id|invalid input syntax/);
      await storefront.query("rollback");
    } finally {
      await storefront.end();
    }

    // the merchant's admin, connected as app_user, still sees every customer in its own store
    const { withShop } = await pgWithShop();
    const rows = await withShop(app, 1n, async (client: pg.PoolClient) => (await client.query("select body from customer_note order by id")).rows);
    assert.deepEqual(rows, [{ body: "ten" }, { body: "eleven" }]);
  });

  it("shopScoped (Option B) filters reads and changes 0 rows for another store's record", async () => {
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient({ datasourceUrl: appUrl.replace("app_user:change-me@", `${new URL(DATABASE_URL!).username}@`) }); // superuser: no policy helps here
    try {
      const { shopScoped } = await importBlock(sql("shop-tenancy.md", "app/db/shopScoped.server.ts"));
      const scoped = shopScoped(prisma, 1n);
      assert.deepEqual(events(await scoped.auditLogs.findMany()), ["a", "b"]);
      const otherStoresRow = (await admin.query("select id from audit_log where event = 'c'")).rows[0].id;
      assert.equal((await scoped.auditLogs.update(BigInt(otherStoresRow), { event: "changed" })).count, 0);
      // the same client without the helper is the failure the reference warns about
      assert.equal((await prisma.auditLog.findMany()).length, 4);
    } finally {
      await prisma.$disconnect();
    }
  });
});

describe("actions-and-transactions.md", { skip }, () => {
  it("a Prisma interactive transaction that outlives its timeout fails with 'Transaction already closed'", async () => {
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient({ datasourceUrl: appUrl });
    try {
      await assert.rejects(
        prisma.$transaction(
          async (tx: any) => {
            await tx.$executeRaw`select pg_sleep(0.4)`;
            await tx.$executeRaw`select 1`;
          },
          { timeout: 100 }
        ),
        /Transaction already closed/
      );
    } finally {
      await prisma.$disconnect();
    }
  });

  it("an outbox row rolls back with its transaction, and two drains at once send each row once", async () => {
    const { drainOutbox } = await importBlock(sql("actions-and-transactions.md", "app/jobs/outbox.server.ts"));
    const pool = new pg.Pool({ connectionString: appUrl, max: 4 });
    try {
      const client = await pool.connect();
      await client.query("begin");
      await client.query(`insert into outbox (job_name, payload) values ('rolledBack', '{}')`);
      await client.query("rollback");
      client.release();
      await pool.query(`insert into outbox (job_name, payload) values ('notify', '{"orderId": "1"}'), ('notify', '{"orderId": "2"}'), ('notify', '{"orderId": "3"}')`);

      const sent: any[] = [];
      const add = async (job: any) => {
        await new Promise((resolve) => setTimeout(resolve, 30)); // long enough for the two drains to overlap
        sent.push(job);
      };
      const moved = await Promise.all([drainOutbox(pool, add), drainOutbox(pool, add)]);
      assert.equal(moved[0] + moved[1], 3);
      assert.deepEqual(sent.map((job) => job.payload.orderId).sort(), ["1", "2", "3"]);
      assert.ok(sent.every((job) => job.name === "notify" && /^outbox-\d+$/.test(job.id)));
      assert.equal((await pool.query("select count(*)::int as count from outbox")).rows[0].count, 0);
    } finally {
      await pool.end();
    }
  });
});

describe("background-jobs.md", { skip }, () => {
  it("withShopSlot allows `slots` jobs per store at once and frees slots afterwards", async () => {
    const { withShopSlot, ShopBusyError } = await importBlock(sql("background-jobs.md", "app/jobs/shopSlots.server.ts"));
    const pool = new pg.Pool({ connectionString: appUrl, max: 5 });
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const first = withShopSlot(pool, "external", "1", 2, () => gate);
      const second = withShopSlot(pool, "external", "1", 2, () => gate);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await assert.rejects(withShopSlot(pool, "external", "1", 2, async () => "third"), ShopBusyError);
      assert.equal(await withShopSlot(pool, "external", "2", 2, async () => "other store"), "other store");
      release();
      await Promise.all([first, second]);
      assert.equal(await withShopSlot(pool, "external", "1", 2, async () => "after"), "after");
    } finally {
      await pool.end();
    }
  });

  it("the cron lock skips a run while another holds it", async () => {
    const { pruneAuditLogs } = await importBlock(blocks("background-jobs.md", "app/cron/pruneAuditLogs.server.ts")[0]);
    const holder = await admin.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended('cron:pruneAuditLogs', 0))");
      assert.equal(await pruneAuditLogs(admin), "skipped: another run holds the lock");
      await holder.query("commit");
      assert.equal(await pruneAuditLogs(admin), "done");
    } finally {
      holder.release();
    }
  });
});

const PGBOUNCER_BIN = process.env.PGBOUNCER_BIN;
const skipWithoutPgBouncer = skip || (!PGBOUNCER_BIN && "set PGBOUNCER_BIN to a pgbouncer binary");

describe("through PgBouncer in transaction mode", { skip: skipWithoutPgBouncer }, () => {
  const port = Number(process.env.PGBOUNCER_PORT ?? 64352);
  let pgbouncer: ChildProcess;
  let adminUser: string;

  // tenancy_one has a single server connection, so every client shares it. tenancy_two has two.
  const pooled = (alias: "tenancy_one" | "tenancy_two", user: string) => `postgres://${user}@127.0.0.1:${port}/${alias}`;

  before(async () => {
    const server = new URL(DATABASE_URL!);
    adminUser = server.username;
    const dir = mkdtempSync(join(tmpdir(), "gadget-migration-pgbouncer-"));
    writeFileSync(join(dir, "userlist.txt"), `"${adminUser}" "${server.password}"\n"app_user" "change-me"\n`);
    const target = `host=${server.hostname} port=${server.port || 5432} dbname=${DATABASE}`;
    writeFileSync(
      join(dir, "pgbouncer.ini"),
      [
        "[databases]",
        `tenancy_one = ${target} pool_size=1`,
        `tenancy_two = ${target} pool_size=2`,
        "[pgbouncer]",
        "listen_addr = 127.0.0.1",
        `listen_port = ${port}`,
        "unix_socket_dir =",
        "auth_type = trust",
        `auth_file = ${join(dir, "userlist.txt")}`,
        "pool_mode = transaction",
        "max_client_conn = 100",
        `logfile = ${join(dir, "pgbouncer.log")}`,
        "",
      ].join("\n")
    );
    pgbouncer = spawn(PGBOUNCER_BIN!, [join(dir, "pgbouncer.ini")], { stdio: "ignore" });

    for (let attempt = 0; ; attempt++) {
      const probe = new pg.Client({ connectionString: pooled("tenancy_one", "app_user") });
      try {
        await probe.connect();
        await probe.query("select 1");
        await probe.end();
        break;
      } catch (error) {
        await probe.end().catch(() => {});
        if (attempt === 50) throw new Error(`PgBouncer did not start, see ${join(dir, "pgbouncer.log")}: ${error}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  after(async () => {
    if (!pgbouncer || pgbouncer.exitCode !== null) return;
    const exited = new Promise((resolve) => pgbouncer.once("exit", resolve));
    pgbouncer.kill("SIGINT"); // immediate shutdown, which also drops the lock the slot test leaves behind
    await exited;
  });

  it("set_config(..., true) keeps two clients' stores apart on one shared server connection", async () => {
    const { withShop } = await pgWithShop();
    const first = new pg.Pool({ connectionString: pooled("tenancy_one", "app_user"), max: 1 });
    const second = new pg.Pool({ connectionString: pooled("tenancy_one", "app_user"), max: 1 });
    try {
      const read = async (client: pg.PoolClient) => {
        await client.query("select pg_sleep(0.05)");
        return (await client.query("select event from audit_log order by id")).rows;
      };
      const [one, two] = await Promise.all([withShop(first, 1n, read), withShop(second, 2n, read)]);
      assert.deepEqual([events(one), events(two)], [["a", "b"], ["c"]]);
      // afterwards the shared server connection has no store, for either client
      await assert.rejects(first.query("select * from audit_log"), /invalid input syntax for type bigint: ""/);
      await assert.rejects(second.query("select * from audit_log"), /invalid input syntax for type bigint: ""/);
    } finally {
      await first.end();
      await second.end();
    }
  });

  it("set_config(..., false) leaks the store to a different client", async () => {
    const first = new pg.Client({ connectionString: pooled("tenancy_one", "app_user") });
    const second = new pg.Client({ connectionString: pooled("tenancy_one", "app_user") });
    await first.connect();
    await second.connect();
    try {
      await first.query("begin");
      await first.query("select set_config('app.shop_id', '2', false)");
      await first.query("commit");
      // another process's connection, which never named a store, now reads store 2
      assert.deepEqual(events((await second.query("select event from audit_log")).rows), ["c"]);
    } finally {
      await second.query("select set_config('app.shop_id', '', false)");
      await first.end();
      await second.end();
    }
  });

  it("withShop (Prisma) works with pgbouncer=true", async () => {
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient({ datasourceUrl: `${pooled("tenancy_one", "app_user")}?pgbouncer=true` });
    try {
      const { withShop } = await prismaWithShop();
      assert.deepEqual(events(await withShop(prisma, 1n, (tx: any) => tx.auditLog.findMany({ orderBy: { id: "asc" } }))), ["a", "b"]);
      await assert.rejects(prisma.auditLog.findMany(), /unrecognized configuration parameter|invalid input syntax/);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("withShopSlot leaves the slot taken when the unlock lands on another server connection", async () => {
    const { withShopSlot, ShopBusyError } = await importBlock(sql("background-jobs.md", "app/jobs/shopSlots.server.ts"));
    const workers = new pg.Pool({ connectionString: pooled("tenancy_two", "app_user"), max: 2 });
    const other = new pg.Client({ connectionString: pooled("tenancy_two", "app_user") });
    await other.connect();
    const heldLocks = async () =>
      (await admin.query("select count(*)::int as count from pg_locks where locktype = 'advisory' and granted and database = (select oid from pg_database where datname = current_database())")).rows[0].count;
    try {
      assert.equal(await heldLocks(), 0);
      // While the job runs, another client's transaction is given the server connection that took the lock.
      assert.equal(
        await withShopSlot(workers, "pooled", "9", 1, async () => {
          await other.query("begin");
          await other.query("select 1");
          return "job done";
        }),
        "job done"
      );
      // The job is finished, but its unlock ran on the second server connection and released nothing.
      assert.equal(await heldLocks(), 1);
      await assert.rejects(withShopSlot(workers, "pooled", "9", 1, async () => "never runs"), ShopBusyError);
    } finally {
      await other.query("rollback");
      await other.end();
      await workers.end();
    }
  });

  it("the transaction-level cron lock works through the pooler", async () => {
    const { pruneAuditLogs } = await importBlock(blocks("background-jobs.md", "app/cron/pruneAuditLogs.server.ts")[0]);
    const viaPooler = new pg.Pool({ connectionString: pooled("tenancy_two", adminUser), max: 2 });
    const holder = await admin.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended('cron:pruneAuditLogs', 0))");
      assert.equal(await pruneAuditLogs(viaPooler), "skipped: another run holds the lock");
      await holder.query("commit");
      assert.equal(await pruneAuditLogs(viaPooler), "done");
      assert.equal(await pruneAuditLogs(viaPooler), "done"); // nothing is left held between runs
    } finally {
      holder.release();
      await viaPooler.end();
    }
  });
});

describe("BullMQ options from background-jobs.md", { skip: skipWithoutRedis }, () => {
  // Starts a queue, a worker, and its events, and closes all three when the test body is done.
  async function withQueue(prefix: string, processor: (job: any) => Promise<unknown>, body: (context: { queue: any; events: any; worker: any }) => Promise<void>, autorun = true) {
    const { Queue, Worker, QueueEvents } = await import("bullmq");
    const connection = redisConnection();
    const name = `${prefix}-${Date.now()}`;
    const queue = new Queue(name, { connection });
    const events = new QueueEvents(name, { connection });
    const worker = new Worker(name, processor, { connection, autorun });
    try {
      await events.waitUntilReady();
      await body({ queue, events, worker });
    } finally {
      await worker.close();
      await events.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  }

  it("retries with Gadget's schedule: 1 s, then 2 s, then 4 s", { timeout: 20_000 }, async () => {
    const attemptsAt: number[] = [];
    const attemptsMade: number[] = [];
    await withQueue(
      "retry",
      async (job) => {
        attemptsAt.push(Date.now());
        attemptsMade.push(job.attemptsMade);
        if (job.attemptsMade < 3) throw new Error("fail");
      },
      async ({ queue, events }) => {
        const job = await queue.add("notifyExternalSystem", {}, { attempts: 7, backoff: { type: "exponential", delay: 1000 } });
        await job.waitUntilFinished(events, 15_000);
        const gaps = attemptsAt.slice(1).map((at, i) => Math.round((at - attemptsAt[i]) / 1000));
        assert.deepEqual(gaps, [1, 2, 4]);
        assert.deepEqual(attemptsMade, [0, 1, 2, 3]); // 0 on the first run
      }
    );
  });

  it("a job with no attempts fails on its first error", async () => {
    let runs = 0;
    await withQueue(
      "no-attempts",
      async () => {
        runs++;
        throw new Error("fail");
      },
      async ({ queue, events }) => {
        const job = await queue.add("notifyExternalSystem", {});
        await assert.rejects(job.waitUntilFinished(events, 5_000), /fail/);
        assert.equal(runs, 1);
        assert.equal((await queue.getJobCounts()).failed, 1);
      }
    );
  });

  it("deduplication with a ttl still drops a repeat after the first job completes; without a ttl it doesn't", async () => {
    let runs = 0;
    await withQueue(
      "dedupe",
      async () => ++runs,
      async ({ queue, events }) => {
        const withTtl = { deduplication: { id: "order-1", ttl: 24 * 60 * 60 * 1000 } };
        const first = await queue.add("notifyExternalSystem", { orderId: "1" }, withTtl);
        const whileWaiting = await queue.add("notifyExternalSystem", { orderId: "1" }, withTtl);
        assert.equal(whileWaiting.id, first.id);
        await first.waitUntilFinished(events, 5_000);
        const afterCompletion = await queue.add("notifyExternalSystem", { orderId: "1" }, withTtl);
        assert.equal(afterCompletion.id, first.id);

        const withoutTtl = { deduplication: { id: "order-2" } };
        const third = await queue.add("notifyExternalSystem", { orderId: "2" }, withoutTtl);
        await third.waitUntilFinished(events, 5_000);
        const fourth = await queue.add("notifyExternalSystem", { orderId: "2" }, withoutTtl);
        assert.notEqual(fourth.id, third.id);
        await fourth.waitUntilFinished(events, 5_000);
        assert.equal(runs, 3); // order-1 once, order-2 twice
      }
    );
  });

  it("a jobId blocks a repeat only while the first job is still stored", async () => {
    const runs: string[] = [];
    await withQueue(
      "job-id",
      async (job) => runs.push(job.id),
      async ({ queue, events }) => {
        const kept = await queue.add("notifyExternalSystem", {}, { jobId: "order-1" });
        await kept.waitUntilFinished(events, 5_000);
        await queue.add("notifyExternalSystem", {}, { jobId: "order-1" });
        const counts = await queue.getJobCounts("waiting", "active", "completed");
        assert.deepEqual([counts.waiting, counts.active, counts.completed], [0, 0, 1]); // the repeat was not queued

        const removed = await queue.add("notifyExternalSystem", {}, { jobId: "order-2", removeOnComplete: true });
        await removed.waitUntilFinished(events, 5_000);
        const again = await queue.add("notifyExternalSystem", {}, { jobId: "order-2", removeOnComplete: true });
        await again.waitUntilFinished(events, 5_000);
        assert.deepEqual(runs, ["order-1", "order-2", "order-2"]);
      }
    );
  });

  it("runs jobs with no priority before every job that has one, then 1, 2, 3", async () => {
    const order: string[] = [];
    await withQueue(
      "priority",
      async (job) => order.push(job.name),
      async ({ queue, worker }) => {
        await queue.add("low", {}, { priority: 3 });
        await queue.add("default", {}, { priority: 2 });
        await queue.add("high", {}, { priority: 1 });
        await queue.add("no priority", {});
        const drained = new Promise((resolve) => worker.once("drained", resolve));
        worker.run();
        await drained;
        assert.deepEqual(order, ["no priority", "high", "default", "low"]);
      },
      false
    );
  });

  it("upsertJobScheduler keeps one schedule when every process registers it at boot", async () => {
    await withQueue(
      "schedule",
      async () => {},
      async ({ queue }) => {
        const register = () =>
          queue.upsertJobScheduler("pruneAuditLogs", { pattern: "0 2 * * *", tz: "UTC" }, { name: "pruneAuditLogs", opts: { attempts: 5, backoff: { type: "exponential", delay: 1000 } } });
        await register();
        await register();
        assert.equal((await queue.getJobSchedulers()).length, 1);
        const delayed = await queue.getDelayed();
        assert.equal(delayed.length, 1);
        assert.equal(delayed[0].name, "pruneAuditLogs");
        assert.equal(delayed[0].opts.attempts, 5);
        assert.equal(new Date(delayed[0].timestamp + delayed[0].opts.delay).getUTCHours(), 2); // without tz the pattern follows the process's time zone, so this fails off UTC if tz is dropped
      }
    );
  });

  it("the per-store worker never runs more than the store's limit at once", { timeout: 30_000 }, async () => {
    const { Queue, Worker, DelayedError } = await import("bullmq");
    const { withShopSlot, ShopBusyError } = await importBlock(sql("background-jobs.md", "app/jobs/shopSlots.server.ts"));
    const pool = new pg.Pool({ connectionString: appUrl, max: 10 });
    const connection = redisConnection();
    const name = `slots-${Date.now()}`;
    const queue = new Queue(name, { connection });
    let running = 0;
    let maxRunning = 0;
    let completed = 0;
    // the worker body from background-jobs.md, with notify() replaced by a 200 ms job
    const worker = new Worker(name, async (job, token) => {
      try {
        await withShopSlot(pool, "external", job.data.shopId, 2, async () => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await new Promise((resolve) => setTimeout(resolve, 200));
          running--;
        });
        completed++;
      } catch (error) {
        if (!(error instanceof ShopBusyError)) throw error;
        await job.moveToDelayed(Date.now() + 100, token);
        throw new DelayedError();
      }
    }, { connection, concurrency: 8 });
    try {
      await queue.addBulk(Array.from({ length: 6 }, (_, i) => ({ name: "notify", data: { shopId: "1", orderId: String(i) }, opts: { attempts: 1 } })));
      const deadline = Date.now() + 20_000;
      while (completed < 6 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(completed, 6);
      assert.equal(maxRunning, 2);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
      await pool.end();
    }
  });

  it("the outbox drain with a BullMQ jobId queues each row once, even when a drain fails halfway and runs again", async () => {
    const { drainOutbox } = await importBlock(sql("actions-and-transactions.md", "app/jobs/outbox.server.ts"));
    const pool = new pg.Pool({ connectionString: appUrl, max: 2 });
    const processed: string[] = [];
    try {
      await withQueue(
        "outbox",
        async (job) => processed.push(job.data.orderId),
        async ({ queue, worker }) => {
          await pool.query(`insert into outbox (job_name, payload) values ('notify', '{"orderId": "1"}'), ('notify', '{"orderId": "2"}'), ('notify', '{"orderId": "3"}')`);
          // the add from the reference's setInterval example
          const add = (job: any) => queue.add(job.name, job.payload, { jobId: job.id, attempts: 7, backoff: { type: "exponential", delay: 1000 } });

          let calls = 0;
          const failsOnSecondRow = async (job: any) => {
            if (++calls === 2) throw new Error("redis went away");
            return add(job);
          };
          await assert.rejects(drainOutbox(pool, failsOnSecondRow), /redis went away/);
          // the first row reached the queue, and all three rows are still in the outbox
          assert.equal((await pool.query("select count(*)::int as count from outbox")).rows[0].count, 3);

          assert.equal(await drainOutbox(pool, add), 3); // sends the first row a second time
          const drained = new Promise((resolve) => worker.once("drained", resolve));
          worker.run();
          await drained;
          assert.deepEqual(processed.sort(), ["1", "2", "3"]);
          assert.equal((await pool.query("select count(*)::int as count from outbox")).rows[0].count, 0);
        },
        false
      );
    } finally {
      await pool.end();
    }
  });
});
