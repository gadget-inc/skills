// Runs the SQL in references/computed-views.md against Postgres.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { sql } from "../coverage-snippets.ts";
import { scratchDatabase, skip } from "./db.ts";

let admin: pg.Pool;
const REPORT = sql("computed-views.md", "db/queries/finished_report.sql");

before(async () => {
  if (skip) return;
  ({ admin } = await scratchDatabase("gadget_migration_views_test"));
  await admin.query(`create table todo (id bigserial primary key, shop_id bigint not null, finished_at timestamptz)`);
  await admin.query(`
    insert into todo (shop_id, finished_at) values
      (1, '2026-03-01T23:30:00Z'), (1, '2026-03-02T00:30:00Z'), (1, '2026-03-02T15:00:00Z'), (1, null),
      (2, '2026-03-02T10:00:00Z')
  `);
});

after(async () => {
  await admin?.end();
});

async function report(shopId: number, timeZone: string) {
  const client = await admin.connect();
  try {
    await client.query(`set time zone '${timeZone}'`);
    const { rows } = await client.query(REPORT, [shopId]);
    return rows.map((row) => `${row.day.getFullYear()}-${row.day.getMonth() + 1}-${row.day.getDate()}: ${row.count}`);
  } finally {
    await client.query("reset time zone");
    client.release();
  }
}

describe("computed-views.md", { skip }, () => {
  it("counts finished todos per day for one store and skips unfinished ones", async () => {
    assert.deepEqual(await report(1, "UTC"), ["2026-3-1: 1", "2026-3-2: 2"]);
    assert.deepEqual(await report(2, "UTC"), ["2026-3-2: 1"]);
  });

  it("returns the same days whatever the session time zone is", async () => {
    assert.deepEqual(await report(1, "America/Los_Angeles"), ["2026-3-1: 1", "2026-3-2: 2"]);
  });

  it("shows the day boundary moving without the pinned zone", async () => {
    const client = await admin.connect();
    try {
      await client.query("set time zone 'America/Los_Angeles'");
      const { rows } = await client.query(
        "select count(*)::int as count from todo where shop_id = 1 and finished_at is not null group by date_trunc('day', finished_at) order by date_trunc('day', finished_at)"
      );
      // 23:30Z and 00:30Z fall on the same Pacific day, so the counts are 2 then 1 instead of 1 then 2
      assert.deepEqual(rows.map((row) => row.count), [2, 1]);
    } finally {
      await client.query("reset time zone");
      client.release();
    }
  });
});
