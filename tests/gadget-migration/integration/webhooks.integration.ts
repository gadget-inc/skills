// Runs the SQL and the changed-field block in references/shopify-webhooks.md against Postgres. See tests/README.md.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { scratchDatabase, skipWithoutDatabase as skip } from "./db.ts";
import { blocks, importBlock, sql } from "./snippets.ts";

let admin: pg.Pool;

before(async () => {
  if (skip) return;
  ({ admin } = await scratchDatabase("gadget_migration_webhooks_test"));
  await admin.query(`
    create table shopify_order (id bigint primary key, shop_id bigint not null, total_price numeric, financial_status text, shopify_updated_at timestamptz);
    create table shopify_order_line_item (id bigint primary key, order_id bigint not null references shopify_order (id) on delete cascade);
  `);
  await admin.query(sql("shopify-webhooks.md", "db/migrations/processed_webhook.sql"));
  await admin.query(sql("actions-and-transactions.md", "db/migrations/outbox.sql"));
});

after(async () => {
  await admin?.end();
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

  describe("the changed-field block, in a webhook job the queue retries", () => {
    // The block runs as a function body with these names in scope, inside the job's transaction.
    // `jobs` is the app's queue client, whose adds run after the commit, where the skill says to queue.
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const changedField = () =>
      new AsyncFunction("client", "orderId", "values", "payload", "upsertOrderFromWebhook", "jobs", blocks("shopify-webhooks.md", "app/jobs/handleOrderUpdated.server.ts")[0]);
    let drainOutbox: Function;

    // Stands in for the queue. Like BullMQ given a jobId, it drops a job whose id it already has.
    // While `down` is above 0, each add throws, as during a Redis failover.
    let queued: { id: string; name: string; data: any }[] = [];
    let down = 0;
    const add = async (name: string, data: any, { jobId }: { jobId: string }) => {
      if (down > 0) {
        down--;
        throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
      }
      if (!queued.some((job) => job.id === jobId)) queued.push({ id: jobId, name, data });
    };

    type Payload = { id: number; total_price: string; financial_status: string; updated_at: string };
    const attempt = async (payload: Payload) => {
      const afterCommit: (() => Promise<unknown>)[] = [];
      const jobs = { add: async (...args: [string, any, { jobId: string }]) => void afterCommit.push(() => add(...args)) };
      const client = await admin.connect();
      try {
        await client.query("begin");
        const values = [payload.id, 1, payload.total_price, payload.financial_status, payload.updated_at];
        await changedField()(client, payload.id, values, payload, webhookUpsert(), jobs);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      for (const run of afterCommit) await run();
    };
    // the webhook queue's 10 attempts
    const processWebhook = async (payload: Payload) => {
      for (let tries = 1; ; tries++) {
        try {
          return await attempt(payload);
        } catch (error) {
          if (tries === 10) throw error;
        }
      }
    };
    // one pass of the drain timer from actions-and-transactions.md, which logs a failed drain and carries on
    const tick = () => drainOutbox(admin, (job: any) => add(job.name, job.payload, { jobId: job.id })).catch(() => {});
    const waiting = async () => (await admin.query("select count(*)::int as count from outbox")).rows[0].count;

    before(async () => {
      ({ drainOutbox } = await importBlock(sql("actions-and-transactions.md", "app/jobs/outbox.server.ts")));
    });

    beforeEach(async () => {
      queued = [];
      down = 0;
      await admin.query("truncate outbox");
    });

    it("still queues the job when the write changes the field and the queue fails once after the commit", async () => {
      await write(webhookUpsert(), [20, 1, "30.00", "pending", "2026-11-08T10:00:00Z"]);
      down = 1; // Redis fails over as the paid webhook arrives
      await processWebhook({ id: 20, total_price: "30.00", financial_status: "paid", updated_at: "2026-11-08T10:05:00Z" });
      await tick();
      await tick();
      assert.deepEqual(
        queued.map((job) => [job.name, String(job.data.orderId)]),
        [["orderPaid", "20"]]
      );
      assert.equal(await waiting(), 0);
    });

    it("queues nothing when the payload leaves the field as it was, or is stale", async () => {
      await write(webhookUpsert(), [21, 1, "30.00", "paid", "2026-11-08T10:00:00Z"]);
      await processWebhook({ id: 21, total_price: "25.00", financial_status: "paid", updated_at: "2026-11-08T10:05:00Z" }); // newer, same status
      await processWebhook({ id: 21, total_price: "30.00", financial_status: "pending", updated_at: "2026-11-08T09:59:00Z" }); // older, arrived late
      await tick();
      assert.deepEqual(queued, []);
      assert.equal(await waiting(), 0);
      assert.deepEqual(await stored(21), { total_price: "25.00", financial_status: "paid" });
    });
  });
});
