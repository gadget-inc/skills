// Runs the SQL, the Prisma schema, and the loader in references/schema-mapping.md and
// references/data-export.md against Postgres. See tests/README.md.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { scratchDatabase, skipWithoutDatabase as skip } from "./db.ts";
import { blocks, importBlock, sql } from "./snippets.ts";

const prisma = fileURLToPath(new URL("./node_modules/.bin/prisma", import.meta.url));
const datasource = 'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n\n';
const scratch = mkdtempSync(join(tmpdir(), "gadget-schema-"));

// The SQL Prisma would run to create the given models in an empty database.
function prismaSql(models: string): string {
  const file = join(scratch, `schema-${Math.random().toString(36).slice(2)}.prisma`);
  writeFileSync(file, datasource + models);
  return execFileSync(prisma, ["migrate", "diff", "--from-empty", "--to-schema-datamodel", file, "--script"], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: "postgres://unused@localhost/unused" },
  });
}

let admin: pg.Pool;
let foreignKeys: string[];
let hasPgvector = false;

before(async () => {
  if (skip) return;
  ({ admin } = await scratchDatabase("gadget_migration_schema_test"));

  // create the tables from the reference's own Prisma schema, holding the foreign keys back the
  // way a migration has to until the orphans are gone
  const statements = prismaSql(blocks("schema-mapping.md", "prisma/schema.prisma")[0]).split(/;\s*\n/);
  foreignKeys = statements.filter((statement) => /FOREIGN KEY/.test(statement));
  await admin.query(statements.filter((statement) => !/FOREIGN KEY/.test(statement)).join(";\n"));
  await admin.query(`
    alter table shopify_order add column customer_id bigint;
    create table shopify_customer (id bigint primary key, shop_id bigint not null);
    create table widget_import (doc jsonb not null);
  `);
  await admin.query(sql("schema-mapping.md", "db/migrations/widget_unique_sku.sql"));
  await admin.query(sql("schema-mapping.md", "db/migrations/customer_total_order_value.sql"));
  hasPgvector = (await admin.query("select 1 from pg_available_extensions where name = 'vector'")).rowCount === 1;
});

after(async () => {
  await admin?.end();
  rmSync(scratch, { recursive: true, force: true });
});

const widget = "insert into widget (id, shop_id, name, sku, updated_at)";

describe("schema-mapping.md", { skip }, () => {
  it("has a Prisma schema that creates the column types the field table names", async () => {
    const { rows } = await admin.query(
      "select table_name || '.' || column_name as col, data_type, numeric_precision from information_schema.columns where table_schema = 'public' and table_name in ('widget', 'shopify_order')"
    );
    const types = Object.fromEntries(rows.map((row) => [row.col, row]));
    assert.equal(types["widget.id"].data_type, "bigint");
    assert.equal(types["widget.price"].data_type, "numeric");
    assert.equal(types["widget.price"].numeric_precision, null); // no fixed scale, like Gadget's decimal
    assert.equal(types["widget.tags"].data_type, "ARRAY");
    assert.equal(types["widget.due_on"].data_type, "date");
    assert.equal(types["widget.updated_at"].data_type, "timestamp with time zone");
    assert.equal(types["shopify_order.total_price"].numeric_precision, null);
  });

  it("shows why Decimal needs @db.Decimal in Prisma", () => {
    assert.match(prismaSql("model Gizmo {\n  id BigInt @id\n  weight Decimal\n}\n"), /"weight" DECIMAL\(65,30\) NOT NULL/);
  });

  it("drifts in double precision and stays exact in numeric", async () => {
    const { rows } = await admin.query("select (0.1::float8 + 0.2::float8)::text as float, (0.1::numeric + 0.2::numeric)::text as numeric");
    assert.deepEqual(rows[0], { float: "0.30000000000000004", numeric: "0.3" });
  });

  it("can't name a table user, order, or group", async () => {
    for (const name of ["user", "order", "group"]) {
      await assert.rejects(admin.query(`create table ${name} (id bigint primary key)`), new RegExp(`syntax error at or near "${name}"`));
    }
    await admin.query("create table users (id bigint primary key)");
  });

  it("finds belongsTo values that point at missing records, which block the foreign key until removed", async () => {
    await admin.query("insert into shopify_shop (id, myshopify_domain) values (1, 'one.myshopify.com')");
    await admin.query(`${widget} values (100, 1, 'kept', 'A-1', now()), (101, 99, 'orphan', 'A-2', now())`);
    const { rows } = await admin.query(sql("schema-mapping.md", "db/checks/orphaned_widgets.sql"));
    assert.deepEqual(rows.map((row) => Number(row.id)), [101]);

    const widgetKey = foreignKeys.find((statement) => /"widget"/.test(statement))!;
    await assert.rejects(admin.query(widgetKey), /violates foreign key constraint/);
    await admin.query("delete from widget where id = 101");
    for (const statement of foreignKeys) await admin.query(statement);
  });

  it("rejects a SKU that differs only in case within a store, and allows it in another store", async () => {
    await admin.query("insert into shopify_shop (id, myshopify_domain) values (2, 'two.myshopify.com')");
    await assert.rejects(admin.query(`${widget} values (102, 1, 'dupe', 'a-1', now())`), /widget_sku_per_shop/);
    await admin.query(`${widget} values (102, 2, 'other store', 'a-1', now())`);
    // like Gadget's own index, it allows any number of records with no value
    await admin.query(`${widget} values (103, 1, 'no sku', null, now()), (104, 1, 'no sku either', null, now())`);
  });

  it("counts the rows a required validation never checked, which block not null and the empty-string check", async () => {
    await admin.query("alter table widget alter column name drop not null"); // the state right after a raw load
    await admin.query(`${widget} values (105, 1, null, null, now()), (106, 1, '', null, now())`);
    const { rows } = await admin.query(sql("schema-mapping.md", "db/checks/widget_missing_names.sql"));
    assert.equal(Number(rows[0].count), 2);
    await assert.rejects(admin.query("alter table widget alter column name set not null"), /contains null values/);
    await assert.rejects(admin.query("alter table widget add constraint widget_name_present check (name <> '')"), /violated by some row/);
    await admin.query("delete from widget where id in (105, 106)");
    await admin.query("alter table widget alter column name set not null, add constraint widget_name_present check (name <> '')");
    await assert.rejects(admin.query(`${widget} values (107, 1, '', null, now())`), /widget_name_present/);
  });

  it("moves the sequence past imported ids, leaving a gap for records Gadget creates before the switch", async () => {
    await admin.query(sql("schema-mapping.md", "db/after_import.sql"));
    const { rows } = await admin.query("insert into widget (shop_id, name, updated_at) values (1, 'new', now()) returning id");
    assert.equal(Number(rows[0].id), 1_000_105); // the highest imported id was 104
    // a record Gadget created after the export arrives in the catch-up load with its next id, and fits in the gap
    await admin.query(`${widget} values (105, 1, 'created in Gadget after the export', null, now())`);
  });

  it("keeps customers with no orders in the computed view", async () => {
    await admin.query("insert into shopify_customer (id, shop_id) values (500, 1), (501, 1)");
    await admin.query("insert into shopify_order (id, shop_id, customer_id, total_price) values (10, 1, 500, 12.50), (12, 1, 500, 5.00)");
    const { rows } = await admin.query("select customer_id::int, total_order_value::text from customer_total_order_value where customer_id in (500, 501) order by customer_id");
    assert.deepEqual(rows, [{ customer_id: 500, total_order_value: "17.50" }, { customer_id: 501, total_order_value: null }]);
  });

  it("reads every store's orders for one store's page until the index exists, although shop_id has a foreign key", async () => {
    const latestOrders = sql("schema-mapping.md", "app/sql/latest_orders.sql").replace(/^-- in .*\n/, "").replace("$1", "1042");
    const client = await admin.connect();
    try {
      // rolled back at the end, so the other tests never see these rows or the index
      await client.query("begin");
      // 20,000 orders across 200 stores, the numbers the reference gives
      await client.query("insert into shopify_shop (id, myshopify_domain) select 1000 + n, 'store-' || n || '.myshopify.com' from generate_series(0, 199) n");
      await client.query(
        "insert into shopify_order (id, shop_id, total_price, shopify_created_at) select 100000 + n, 1000 + n % 200, 10, now() - n * interval '1 minute' from generate_series(0, 19999) n"
      );
      // start from what Postgres gives a foreign key column by itself: the constraint and no index
      const { rows: indexes } = await client.query("select indexname from pg_indexes where tablename = 'shopify_order' and indexname <> 'shopify_order_pkey'");
      for (const { indexname } of indexes) await client.query(`drop index "${indexname}"`);
      const foreignKey = "select 1 from pg_constraint where conrelid = 'shopify_order'::regclass and contype = 'f'";
      // an earlier test adds the foreign keys. Add this one here when that test was filtered out
      if ((await client.query(foreignKey)).rowCount === 0) await client.query(foreignKeys.find((statement) => /"shopify_order"/.test(statement))!);
      assert.equal((await client.query(foreignKey)).rowCount, 1);
      await client.query("analyze shopify_order");

      const plan = async () => (await client.query(`explain ${latestOrders}`)).rows.map((row) => row["QUERY PLAN"]).join("\n");
      const before = await plan();
      assert.match(before, /Seq Scan on shopify_order/);
      assert.doesNotMatch(before, /Index/);

      await client.query(sql("schema-mapping.md", "db/migrations/shopify_order_shop_created_index.sql"));
      await client.query("analyze shopify_order");
      const after = await plan();
      assert.match(after, /Index Scan using shopify_order_shop_id_shopify_created_at_idx/);
      assert.doesNotMatch(after, /Seq Scan|Sort/); // the index also returns the rows already in order

      // the query returns the store's 50 newest orders either way
      const { rows } = await client.query(latestOrders);
      assert.equal(rows.length, 50);
      assert.equal(Number(rows[0].id), 100000 + 42);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("reads a date-only value the same in any session time zone when cast straight to date", async () => {
    const client = await admin.connect();
    try {
      await client.query("set timezone = 'America/Los_Angeles'");
      const { rows } = await client.query("select '2026-11-07T00:00:00.000Z'::date::text as direct, '2026-11-07T00:00:00.000Z'::timestamptz::date::text as through_timestamptz");
      assert.deepEqual(rows[0], { direct: "2026-11-07", through_timestamptz: "2026-11-06" });
    } finally {
      client.release();
    }
  });

  it("indexes a vector column the way Gadget did, up to 2,000 dimensions", { skip: skip || undefined }, async (t) => {
    if (!hasPgvector) return t.skip("pgvector is not installed on this server");
    await admin.query("create extension if not exists vector");
    await admin.query("alter table widget add column embedding vector(3)");
    await admin.query(sql("schema-mapping.md", "db/migrations/widget_embedding_index.sql"));
    await admin.query("update widget set embedding = '[1,0,0]' where id = 100");
    await admin.query("update widget set embedding = '[0,1,0]' where id = 102");
    const { rows } = await admin.query("select id::int from widget where embedding is not null order by embedding <=> '[0.9,0.1,0]' limit 1");
    assert.equal(rows[0].id, 100);

    await admin.query("create table wide (id bigint primary key, fits vector(2000), too_wide vector(2001))");
    await admin.query("create index on wide using hnsw (fits vector_cosine_ops)");
    await assert.rejects(admin.query("create index on wide using hnsw (too_wide vector_cosine_ops)"), /2000 dimensions/);
  });
});

describe("data-export.md", { skip }, () => {
  const record = (id: number, name: string, updatedAt: string, sku: string | null = null) =>
    JSON.stringify({ id: String(id), shop: "1", name, sku, createdAt: "2026-01-01T00:00:00.000Z", updatedAt });

  async function load(lines: string[]) {
    const file = join(scratch, `export-${Math.random().toString(36).slice(2)}.ndjson`);
    writeFileSync(file, lines.join("\n") + "\n");
    const { loadNdjson } = await importBlock(blocks("data-export.md", "scripts/load-ndjson.ts")[0]);
    await admin.query("truncate widget_import");
    const loaded = await loadNdjson(admin, file, "widget_import");
    await admin.query(sql("data-export.md", "db/load_widget.sql"));
    return loaded;
  }
  const names = async (ids: number[]) =>
    Object.fromEntries((await admin.query("select id::int, name from widget where id = any($1)", [ids])).rows.map((row) => [row.id, row.name]));

  it("loads an export file whose text has quotes, backslashes, tabs, and non-ASCII characters", async () => {
    const tricky = 'He said "hi" \\ C:\\temp\tünï 日本 \n second line';
    const loaded = await load([record(200, tricky, "2026-11-01T00:00:00.000Z"), record(201, "plain", "2026-11-01T00:00:00.000Z")]);
    assert.equal(loaded, 2);
    assert.deepEqual(await names([200, 201]), { 200: tricky, 201: "plain" });
    const { rows } = await admin.query("select shop_id::int, sku, created_at = '2026-01-01T00:00:00Z' as created_kept, updated_at = '2026-11-01T00:00:00Z' as updated_kept from widget where id = 200");
    assert.deepEqual(rows[0], { shop_id: 1, sku: null, created_kept: true, updated_kept: true });
  });

  it("loads a file where a restarted export repeated a page", async () => {
    const page = [record(210, "first", "2026-11-01T00:00:00.000Z"), record(211, "second", "2026-11-01T00:00:00.000Z")];
    await load([...page, ...page, record(212, "third", "2026-11-01T00:00:00.000Z")]);
    assert.deepEqual(await names([210, 211, 212]), { 210: "first", 211: "second", 212: "third" });

    // the same upsert without `distinct on` fails on the repeated ids still sitting in widget_import
    const withoutDistinct = sql("data-export.md", "db/load_widget.sql").replace(/select distinct on \(.*\)\n/, "select\n").replace(/order by .*\n/, "");
    assert.doesNotMatch(withoutDistinct, /distinct on/);
    await assert.rejects(admin.query(withoutDistinct), /cannot affect row a second time/);
  });

  it("applies a catch-up export, and never lets an older copy overwrite a newer row", async () => {
    await load([record(210, "renamed", "2026-11-05T00:00:00.000Z")]);
    assert.deepEqual(await names([210]), { 210: "renamed" });
    await load([record(210, "stale", "2026-11-02T00:00:00.000Z")]);
    assert.deepEqual(await names([210]), { 210: "renamed" });
  });

  it("loads more records than fit in one insert", async () => {
    const many = Array.from({ length: 2500 }, (_, index) => record(1000 + index, `bulk ${index}`, "2026-11-01T00:00:00.000Z"));
    assert.equal(await load(many), 2500);
    const { rows } = await admin.query("select count(*)::int from widget where id between 1000 and 3499");
    assert.equal(rows[0].count, 2500);
  });

  it("loses the new app's change to the catch-up when its update leaves updated_at alone", async () => {
    await load([record(300, "from Gadget", "2020-01-01T09:00:00.000Z")]);
    await admin.query("update widget set name = 'renamed in the new app' where id = 300");
    await load([record(300, "changed in Gadget", "2020-01-01T10:05:00.000Z")]);
    assert.deepEqual(await names([300]), { 300: "changed in Gadget" });
  });

  it("keeps the new app's change once the trigger moves updated_at, and keeps Gadget's time on loaded rows", async () => {
    await admin.query(sql("data-export.md", "db/migrations/widget_updated_at.sql"));
    try {
      // the same scenario with the trigger: the plain SQL update now moves updated_at, so the older copy is skipped
      await load([record(310, "from Gadget", "2020-01-01T09:00:00.000Z")]);
      await admin.query("update widget set name = 'renamed in the new app' where id = 310");
      await load([record(310, "changed in Gadget", "2020-01-01T10:05:00.000Z")]);
      assert.deepEqual(await names([310]), { 310: "renamed in the new app" });

      // a row the new app never touched takes Gadget's newer copy, and repeating that copy keeps Gadget's time
      await load([record(311, "first", "2020-01-01T09:00:00.000Z")]);
      await load([record(311, "second", "2020-01-01T10:05:00.000Z")]);
      await load([record(311, "second", "2020-01-01T10:05:00.000Z")]);
      const gadgetTime = "select name, updated_at = '2020-01-01T10:05:00Z' as gadget_time from widget where id = 311";
      assert.deepEqual((await admin.query(gadgetTime)).rows[0], { name: "second", gadget_time: true });

      // an update that changes nothing, or sets updated_at itself as Prisma's @updatedAt does, keeps its value
      await admin.query("update widget set name = name where id = 311");
      await admin.query("update widget set name = 'third', updated_at = '2020-01-01T11:00:00Z' where id = 300");
      assert.deepEqual((await admin.query(gadgetTime)).rows[0], { name: "second", gadget_time: true });
      const { rows } = await admin.query("select updated_at = '2020-01-01T11:00:00Z' as kept from widget where id = 300");
      assert.equal(rows[0].kept, true);

      // a trigger that always writes now() stamps the load time on a repeated copy instead
      await admin.query("create or replace function set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end; $$");
      await load([record(311, "second", "2020-01-01T10:05:00.000Z")]);
      assert.deepEqual((await admin.query(gadgetTime)).rows[0], { name: "second", gadget_time: false });
    } finally {
      await admin.query("drop trigger if exists widget_set_updated_at on widget; drop function if exists set_updated_at()");
    }
  });
});
