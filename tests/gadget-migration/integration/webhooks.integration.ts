// Runs the SQL in references/shopify-webhooks.md against Postgres. See tests/README.md.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { scratchDatabase, skipWithoutDatabase as skip } from "./db.ts";
import { sql } from "./snippets.ts";

let admin: pg.Pool;

before(async () => {
  if (skip) return;
  ({ admin } = await scratchDatabase("gadget_migration_webhooks_test"));
  await admin.query(`
    create table shopify_order (id bigint primary key, shop_id bigint not null, total_price numeric, financial_status text, shopify_updated_at timestamptz);
    create table shopify_order_line_item (id bigint primary key, order_id bigint not null references shopify_order (id) on delete cascade);
  `);
  await admin.query(sql("shopify-webhooks.md", "db/migrations/processed_webhook.sql"));
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
});
