// Runs the SQL and TypeScript snippets from the gadget-migration references against real services.
//
//   cd tests/gadget-migration/integration && npm install
//   DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres REDIS_URL=redis://127.0.0.1:6379 npm test
//
// DATABASE_URL must be a superuser: the tests create a scratch database and the app_user role.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { blocks, importBlock, sql } from "./snippets.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const skip = !DATABASE_URL && "set DATABASE_URL to a Postgres superuser URL";
const TEST_DB = "gadget_migration_skill_test";

const redisConnection = () => {
  const url = new URL(REDIS_URL!);
  return { host: url.hostname, port: Number(url.port || 6379) };
};

let admin: pg.Pool; // superuser, owns the tables
let app: pg.Pool; // app_user, subject to row-level security
let appUrl: string;

before(async () => {
  if (skip) return;
  const bootstrap = new pg.Client({ connectionString: DATABASE_URL });
  await bootstrap.connect();
  await bootstrap.query(`drop database if exists ${TEST_DB}`);
  await bootstrap.query("drop role if exists app_user");
  await bootstrap.query(`create database ${TEST_DB}`);
  await bootstrap.end();

  const url = new URL(DATABASE_URL!);
  url.pathname = `/${TEST_DB}`;
  admin = new pg.Pool({ connectionString: url.toString() });
  await admin.query(`
    create table shopify_shop (id bigint primary key, myshopify_domain text not null);
    create table audit_log (id bigserial primary key, shop_id bigint not null, event text not null, created_at timestamptz not null default now());
    create table shopify_customer (id bigint primary key, shop_id bigint not null);
    create table shopify_order (id bigint primary key, shop_id bigint not null, customer_id bigint, total_price numeric, financial_status text, shopify_updated_at timestamptz);
    create table shopify_order_line_item (id bigint primary key, order_id bigint not null references shopify_order (id) on delete cascade);
    create table widget (id bigserial primary key, shop_id bigint, name text, sku text);
    insert into audit_log (shop_id, event) values (1, 'a'), (1, 'b'), (2, 'c'), (3, 'd');
  `);
  await admin.query(sql("shop-tenancy.md", "db/migrations/shop_isolation.sql"));
  await admin.query(sql("shopify-webhooks.md", "db/migrations/processed_webhook.sql"));
  await admin.query(sql("schema-mapping.md", "db/migrations/widget_unique_sku.sql"));
  await admin.query(sql("schema-mapping.md", "db/migrations/customer_total_order_value.sql"));
  await admin.query(sql("shop-tenancy.md", "db/migrations/app_role.sql"));

  url.username = "app_user";
  url.password = "change-me";
  appUrl = url.toString();
  app = new pg.Pool({ connectionString: appUrl, max: 1 }); // one connection, so reuse is observable
});

after(async () => {
  await app?.end();
  await admin?.end();
});

describe("shop-tenancy.md", { skip }, () => {
  it("withShop (node-postgres) returns only the current store's rows", async () => {
    const source = blocks("shop-tenancy.md", "app/db/withShop.server.ts").find((block) => block.includes('from "pg"'))!;
    const { withShop } = await importBlock(source);
    const rows = await withShop(app, 1n, async (client: pg.PoolClient) => (await client.query("select event from audit_log order by id")).rows);
    assert.deepEqual(rows.map((row: any) => row.event), ["a", "b"]);
  });

  it("rejects a write with another store's shop_id", async () => {
    const source = blocks("shop-tenancy.md", "app/db/withShop.server.ts").find((block) => block.includes('from "pg"'))!;
    const { withShop } = await importBlock(source);
    await assert.rejects(
      withShop(app, 1n, (client: pg.PoolClient) => client.query("insert into audit_log (shop_id, event) values (2, 'forged')")),
      /new row violates row-level security policy/
    );
  });

  it("fails a query on a connection that never set the store", async () => {
    const fresh = new pg.Client({ connectionString: appUrl });
    await fresh.connect();
    await assert.rejects(fresh.query("select * from audit_log"), /unrecognized configuration parameter "app.shop_id"/);
    await fresh.end();
  });

  it("fails a query on a pooled connection after an earlier transaction set the store", async () => {
    const source = blocks("shop-tenancy.md", "app/db/withShop.server.ts").find((block) => block.includes('from "pg"'))!;
    const { withShop } = await importBlock(source);
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
      assert.deepEqual(rows.map((row) => row.event), ["c"]); // the next request on this connection sees store 2
    } finally {
      await client.query("select set_config('app.shop_id', '', false)");
      client.release();
    }
  });

  it("is skipped entirely for a superuser connection", async () => {
    const { rows } = await admin.query("select count(*)::int as count from audit_log");
    assert.equal(rows[0].count, 4);
  });

  it("withShop (Prisma) returns only the current store's rows", async () => {
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient({ datasourceUrl: appUrl });
    try {
      const source = blocks("shop-tenancy.md", "app/db/withShop.server.ts").find((block) => block.includes("@prisma/client"))!;
      const { withShop } = await importBlock(source);
      const logs = await withShop(prisma, 2n, (tx: any) => tx.auditLog.findMany());
      assert.deepEqual(logs.map((log: any) => log.event), ["c"]);
      await assert.rejects(prisma.auditLog.findMany(), /unrecognized configuration parameter|invalid input syntax/);
    } finally {
      await prisma.$disconnect();
    }
  });
});

describe("shopify-webhooks.md", { skip }, () => {
  const webhookUpsert = () => sql("shopify-webhooks.md", "app/sql/upsert_order_from_webhook.sql");
  const reconcileUpsert = () => sql("shopify-webhooks.md", "app/sql/upsert_order_from_reconciliation.sql");
  const write = async (statement: string, values: unknown[]) => (await admin.query(statement, values)).rowCount;
  const stored = async (id: number) => (await admin.query("select total_price::text, financial_status from shopify_order where id = $1", [id])).rows[0];

  it("ignores older and equal payloads and applies newer ones", async () => {
    assert.equal(await write(webhookUpsert(), [10, 1, "12.50", "pending", "2026-11-08T10:00:05Z"]), 1);
    assert.equal(await write(webhookUpsert(), [10, 1, "9.00", "pending", "2026-11-08T10:00:02Z"]), 0); // older, arrived late
    assert.equal(await write(webhookUpsert(), [10, 1, "9.00", "paid", "2026-11-08T10:00:05Z"]), 0); // same second
    assert.deepEqual(await stored(10), { total_price: "12.50", financial_status: "pending" });
    assert.equal(await write(webhookUpsert(), [10, 1, "12.50", "paid", "2026-11-08T10:00:09Z"]), 1);
    assert.deepEqual(await stored(10), { total_price: "12.50", financial_status: "paid" });
  });

  it("writes over a row with no stored timestamp", async () => {
    await admin.query("insert into shopify_order (id, shop_id, total_price) values (11, 1, 1)");
    assert.equal(await write(webhookUpsert(), [11, 1, "2.00", "paid", "2026-11-08T10:00:00Z"]), 1);
  });

  it("lets reconciliation repair a same-second change only when a field differs", async () => {
    await write(webhookUpsert(), [12, 1, "5.00", "pending", "2026-11-08T11:00:00Z"]);
    assert.equal(await write(reconcileUpsert(), [12, 1, "5.00", "pending", "2026-11-08T11:00:00Z"]), 0);
    assert.equal(await write(reconcileUpsert(), [12, 1, "5.00", "paid", "2026-11-08T11:00:00Z"]), 1);
    assert.equal(await write(reconcileUpsert(), [12, 1, "1.00", "refunded", "2026-11-08T10:59:59Z"]), 0);
    assert.deepEqual(await stored(12), { total_price: "5.00", financial_status: "paid" });
  });

  it("prunes line items missing from the payload", async () => {
    await write(webhookUpsert(), [13, 1, "5.00", "paid", "2026-11-08T12:00:00Z"]);
    await admin.query("insert into shopify_order_line_item (id, order_id) values (1, 13), (2, 13), (3, 13)");
    await admin.query(sql("shopify-webhooks.md", "app/sql/prune_line_items.sql"), [13, [1, 3]]);
    const { rows } = await admin.query("select id::int from shopify_order_line_item where order_id = 13 order by id");
    assert.deepEqual(rows.map((row) => row.id), [1, 3]);
  });

  it("records a webhook id only when the write commits", async () => {
    const process = async (webhookId: string, fail: boolean) => {
      const client = await admin.connect();
      try {
        await client.query("begin");
        const { rowCount } = await client.query("insert into processed_webhook (webhook_id) values ($1) on conflict do nothing", [webhookId]);
        if (rowCount === 0) {
          await client.query("rollback");
          return "duplicate";
        }
        if (fail) throw new Error("write failed");
        await client.query("commit");
        return "processed";
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    };
    await assert.rejects(process("wh-1", true), /write failed/);
    assert.equal(await process("wh-1", false), "processed"); // the retry is not dropped
    assert.equal(await process("wh-1", false), "duplicate");
  });
});

describe("schema-mapping.md", { skip }, () => {
  it("finds belongsTo values that point at missing records", async () => {
    await admin.query("insert into shopify_shop (id, myshopify_domain) values (1, 'one.myshopify.com')");
    await admin.query("insert into widget (id, shop_id, name, sku) values (100, 1, 'kept', 'A-1'), (101, 99, 'orphan', 'A-2')");
    const { rows } = await admin.query(sql("schema-mapping.md", "db/checks/orphaned_widgets.sql"));
    assert.deepEqual(rows.map((row) => Number(row.id)), [101]);
  });

  it("rejects a SKU that differs only in case within a store", async () => {
    await assert.rejects(admin.query("insert into widget (shop_id, name, sku) values (1, 'dupe', 'a-1')"), /widget_sku_per_shop/);
    await admin.query("insert into widget (id, shop_id, name, sku) values (102, 2, 'other store', 'a-1')");
  });

  it("moves the sequence past imported ids", async () => {
    await admin.query(sql("schema-mapping.md", "db/after_import.sql"));
    const { rows } = await admin.query("insert into widget (shop_id, name) values (1, 'new') returning id");
    assert.equal(Number(rows[0].id), 103);
  });

  it("keeps customers with no orders in the computed view", async () => {
    await admin.query("insert into shopify_customer (id, shop_id) values (500, 1), (501, 1)");
    await admin.query("update shopify_order set customer_id = 500 where id in (10, 12)");
    const { rows } = await admin.query("select customer_id::int, total_order_value::text from customer_total_order_value where customer_id in (500, 501) order by customer_id");
    assert.deepEqual(rows, [{ customer_id: 500, total_order_value: "17.50" }, { customer_id: 501, total_order_value: null }]);
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
    const source = blocks("background-jobs.md", "app/cron/pruneAuditLogs.server.ts")[0];
    const { pruneAuditLogs } = await importBlock(source);
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

describe("BullMQ options from background-jobs.md", { skip: skip || (!REDIS_URL && "set REDIS_URL") }, () => {
  it("retries with Gadget's schedule: 1 s, then 2 s, then 4 s", { timeout: 20_000 }, async () => {
    const { Queue, Worker, QueueEvents } = await import("bullmq");
    const connection = redisConnection();
    const name = `retry-${Date.now()}`;
    const queue = new Queue(name, { connection });
    const attemptsAt: number[] = [];
    const worker = new Worker(name, async (job) => {
      attemptsAt.push(Date.now());
      if (job.attemptsMade < 3) throw new Error("fail");
    }, { connection });
    const events = new QueueEvents(name, { connection });
    try {
      const job = await queue.add("notifyExternalSystem", {}, { attempts: 7, backoff: { type: "exponential", delay: 1000 } });
      await job.waitUntilFinished(events, 15_000);
      const gaps = attemptsAt.slice(1).map((at, i) => Math.round((at - attemptsAt[i]) / 1000));
      assert.deepEqual(gaps, [1, 2, 4]);
    } finally {
      await worker.close();
      await events.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it("drops a second add with the same deduplication id", async () => {
    const { Queue } = await import("bullmq");
    const queue = new Queue(`dedupe-${Date.now()}`, { connection: redisConnection() });
    try {
      const options = { deduplication: { id: "order-1", ttl: 24 * 60 * 60 * 1000 } };
      const first = await queue.add("notifyExternalSystem", { orderId: "1" }, options);
      const second = await queue.add("notifyExternalSystem", { orderId: "1" }, options);
      assert.equal(second.id, first.id);
      assert.equal(await queue.count(), 1);
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
    }
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
});
