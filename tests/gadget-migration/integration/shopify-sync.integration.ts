// Runs the deleted-record sweep in references/shopify-sync.md against Postgres. See tests/README.md.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { scratchDatabase, skipWithoutDatabase as skip } from "./db.ts";
import { importBlock, sql } from "./snippets.ts";

let admin: pg.Pool;
let deleteMissing: (db: pg.Pool, options: object) => Promise<bigint[]>;

before(async () => {
  if (skip) return;
  ({ admin } = await scratchDatabase("gadget_migration_shopify_sync_test"));
  await admin.query(
    "create table shopify_order (id bigint primary key, shop_id bigint not null, shopify_created_at timestamptz, shopify_updated_at timestamptz)"
  );
  ({ deleteMissing } = await importBlock(sql("shopify-sync.md", "app/jobs/deleteMissing.server.ts")));
});

after(async () => {
  await admin?.end();
});

// the list started at 14:00, after the switch
const listStartedAt = new Date("2026-11-10T14:00:00Z");
const order = (id: bigint, shopId: number, createdAt: string, updatedAt: string | null) =>
  admin.query("insert into shopify_order values ($1, $2, $3, $4)", [id.toString(), shopId, createdAt, updatedAt]);
const remaining = async () =>
  (await admin.query("select id from shopify_order order by id")).rows.map((row) => BigInt(row.id));

describe("shopify-sync.md", { skip }, () => {
  beforeEach(async () => {
    await admin.query("truncate shopify_order");
  });

  it("deletes the store's rows Shopify no longer lists, and keeps new rows and other stores' rows", async () => {
    await order(5123456789n, 1, "2026-11-02T10:00:00Z", "2026-11-10T08:30:00Z"); // backfilled at 09:00, deleted in Shopify at 11:00
    await order(5123456790n, 1, "2026-11-03T10:00:00Z", "2026-11-10T08:45:00Z"); // still in Shopify
    await order(5123456791n, 1, "2026-11-10T14:05:00Z", "2026-11-10T14:05:00Z"); // created while the list ran, and not in it
    await order(5123456792n, 1, "2026-11-04T10:00:00Z", null); // no Shopify time stored
    await order(6000000001n, 2, "2026-11-02T10:00:00Z", "2026-11-10T08:30:00Z"); // another store, not in store 1's list

    const deleted = await deleteMissing(admin, {
      shopId: 1n,
      table: "shopify_order",
      currentIds: new Set([5123456790n]),
      listStartedAt,
    });

    assert.deepEqual(deleted, [5123456789n]);
    assert.deepEqual(await remaining(), [5123456790n, 5123456791n, 5123456792n, 6000000001n]);
  });

  it("keeps orders older than the query's window when the caller passes createdSince", async () => {
    await order(5000000001n, 1, "2026-08-01T10:00:00Z", "2026-08-02T10:00:00Z"); // 100 days old, outside a list without read_all_orders
    await order(5000000002n, 1, "2026-11-01T10:00:00Z", "2026-11-09T10:00:00Z"); // recent, deleted in Shopify
    await order(5000000003n, 1, "2026-11-05T10:00:00Z", "2026-11-09T10:00:00Z"); // recent, still in Shopify
    const options = { shopId: 1n, table: "shopify_order", currentIds: new Set([5000000003n]), listStartedAt };

    // without the cutoff, the old order looks deleted because the list could never contain it,
    // and maxDeletes rolls that back instead of deleting both
    await assert.rejects(deleteMissing(admin, { ...options, maxDeletes: 1 }), /would delete 2 rows from shopify_order for shop 1, over maxDeletes 1/);
    assert.deepEqual(await remaining(), [5000000001n, 5000000002n, 5000000003n]);

    const createdSince = new Date(listStartedAt.getTime() - 59 * 24 * 60 * 60 * 1000);
    assert.deepEqual(await deleteMissing(admin, { ...options, createdSince }), [5000000002n]);
    assert.deepEqual(await remaining(), [5000000001n, 5000000003n]);
  });

  it("deletes every older row of the store when Shopify lists none", async () => {
    await order(5000000004n, 1, "2026-11-01T10:00:00Z", "2026-11-09T10:00:00Z");
    await order(6000000002n, 2, "2026-11-01T10:00:00Z", "2026-11-09T10:00:00Z");
    assert.deepEqual(await deleteMissing(admin, { shopId: 1n, table: "shopify_order", currentIds: new Set(), listStartedAt }), [5000000004n]);
    assert.deepEqual(await remaining(), [6000000002n]);
  });

  it("refuses a table name that isn't a plain identifier", async () => {
    await assert.rejects(
      deleteMissing(admin, { shopId: 1n, table: "shopify_order; drop table shopify_order", currentIds: new Set(), listStartedAt }),
      /unexpected table name/
    );
  });
});
