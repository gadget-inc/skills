// Runs the SQL and TypeScript in references/search.md against Postgres and checks the results
// against the behaviors the reference lists for Gadget's search.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { importBlock, sql, blocks } from "../coverage-snippets.ts";
import { scratchDatabase, skip } from "./db.ts";

let admin: pg.Pool;
let toSearchQuery: (input: string) => string | null;
const SEARCH = sql("search.md", "db/queries/search_widgets.sql");

async function search(shopId: number, input: string): Promise<string[]> {
  const query = toSearchQuery(input);
  assert.ok(query, `no query built for ${JSON.stringify(input)}`);
  const { rows } = await admin.query(SEARCH, [shopId, query]);
  return rows.map((row) => row.name);
}

before(async () => {
  ({ toSearchQuery } = await importBlock(blocks("search.md", "app/services/search.server.ts")[0]));
  if (skip) return;
  ({ admin } = await scratchDatabase("gadget_migration_search_test"));
  await admin.query(`create table widget (id bigint primary key, shop_id bigint not null, name text, contact_email text, description text)`);
  await admin.query(sql("search.md", "db/migrations/widget_search.sql"));
  await admin.query(`
    insert into widget (id, shop_id, name, contact_email, description) values
      (1, 1, 'Blue widget', 'jane@example.com', 'A small gadget for the desk'),
      (2, 1, 'Red widget', 'sam@example.org', 'Painted blue on the inside'),
      (3, 1, 'Desk lamp AB-1042', null, 'Not a widget'),
      (4, 2, 'Blue widget', 'other@example.com', 'Another store')
  `);
});

after(async () => {
  await admin?.end();
});

describe("toSearchQuery", () => {
  it("matches every word and makes the last one a prefix", () => {
    assert.equal(toSearchQuery("Blue wid"), "blue | wid:*");
    assert.equal(toSearchQuery("  widget "), "widget:*");
  });

  it("returns null when there is nothing to search for", () => {
    assert.equal(toSearchQuery(""), null);
    assert.equal(toSearchQuery(" -- & | "), null);
  });

  it("keeps only letters and digits from hostile input", () => {
    assert.equal(toSearchQuery("'); drop table widget; --"), "drop | table | widget:*");
    assert.equal(toSearchQuery("O'Brien & co:*"), "o | brien | co:*");
  });
});

describe("search.md against Postgres", { skip }, () => {
  it("ignores case and treats the last word as a prefix", async () => {
    assert.deepEqual(await search(1, "WIDGET"), ["Blue widget", "Red widget", "Desk lamp AB-1042"]);
    assert.deepEqual(await search(1, "lam"), ["Desk lamp AB-1042"]);
  });

  it("matches on any word and ranks records that match more words first", async () => {
    // "Blue widget" matches both words in its name, "Red widget" one in its name and one in its description
    assert.deepEqual((await search(1, "blue widget")).slice(0, 2), ["Blue widget", "Red widget"]);
  });

  it("ranks a name match above a description match", async () => {
    assert.deepEqual(await search(1, "blue"), ["Blue widget", "Red widget"]);
  });

  it("does not stem", async () => {
    assert.deepEqual(await search(1, "widgets"), []);
  });

  it("finds the parts of an email address and a SKU", async () => {
    assert.deepEqual(await search(1, "jane"), ["Blue widget"]);
    assert.deepEqual(await search(1, "example"), ["Blue widget", "Red widget"]);
    assert.deepEqual(await search(1, "1042"), ["Desk lamp AB-1042"]);
  });

  it("shows why the raw column is not enough", async () => {
    const { rows } = await admin.query(`
      select to_tsvector('simple', 'jane@example.com') @@ to_tsquery('simple', 'example:*') as email_domain,
             to_tsvector('simple', 'jane@example.com') @@ to_tsquery('simple', 'jane & smith:*') as email_name_then_word,
             to_tsvector('simple', 'Desk lamp AB-1042') @@ to_tsquery('simple', '1042:*') as sku_number
    `);
    assert.deepEqual(rows[0], { email_domain: false, email_name_then_word: false, sku_number: false });
  });

  it("stays inside one store", async () => {
    assert.deepEqual(await search(2, "blue"), ["Blue widget"]);
  });

  it("survives hostile input", async () => {
    assert.deepEqual(await search(1, "'); drop table widget; --"), ["Blue widget", "Red widget", "Desk lamp AB-1042"]);
    const { rows } = await admin.query("select count(*)::int as count from widget");
    assert.equal(rows[0].count, 4);
  });

  it("uses the GIN index", async () => {
    await admin.query("set enable_seqscan = off");
    const { rows } = await admin.query(`explain select id from widget where search @@ to_tsquery('simple', 'blue:*')`);
    await admin.query("reset enable_seqscan");
    assert.match(rows.map((row) => row["QUERY PLAN"]).join("\n"), /widget_search_idx/);
  });
});
