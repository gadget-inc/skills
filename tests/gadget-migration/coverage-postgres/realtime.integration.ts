// Runs the trigger and the listener from references/realtime.md against Postgres.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type pg from "pg";
import { blocks, sql } from "../coverage-snippets.ts";
import { scratchDatabase, skip } from "./db.ts";

let admin: pg.Pool;
let listener: pg.Client;
let received: any[] = [];
let otherStore: any[] = [];

// the listener block imports `pg` and node:events at runtime, so write it next to this file's node_modules
async function importListener(): Promise<any> {
  const { writeFileSync, rmSync } = await import("node:fs");
  const file = new URL("./.changes.server.generated.ts", import.meta.url);
  writeFileSync(file, blocks("realtime.md", "app/services/changes.server.ts")[0]);
  try {
    return await import(file.href);
  } finally {
    rmSync(file);
  }
}

async function settle() {
  // notifications arrive on the listener's socket shortly after the writer's commit returns
  await sleep(150);
}

before(async () => {
  if (skip) return;
  let url: string;
  ({ admin, url } = await scratchDatabase("gadget_migration_realtime_test"));
  await admin.query(`create table widget (id bigserial primary key, shop_id bigint not null, name text)`);
  await admin.query(sql("realtime.md", "db/migrations/notify_changes.sql"));
  const { changes, listenForChanges } = await importListener();
  changes.on("shop:1", (change: unknown) => received.push(change));
  changes.on("shop:2", (change: unknown) => otherStore.push(change));
  listener = await listenForChanges(url);
});

after(async () => {
  await listener?.end();
  await admin?.end();
});

describe("realtime.md", { skip }, () => {
  it("announces inserts, updates, and deletes with ids only", async () => {
    await admin.query("insert into widget (id, shop_id, name) values (10, 1, 'first')");
    await admin.query("update widget set name = 'renamed' where id = 10");
    await admin.query("delete from widget where id = 10");
    await settle();
    assert.deepEqual(received, [
      { table: "widget", op: "insert", id: 10, shop_id: 1 },
      { table: "widget", op: "update", id: 10, shop_id: 1 },
      { table: "widget", op: "delete", id: 10, shop_id: 1 },
    ]);
  });

  it("routes each change to its own store's channel", async () => {
    received = [];
    await admin.query("insert into widget (id, shop_id, name) values (20, 2, 'other store')");
    await settle();
    assert.deepEqual(received, []);
    assert.deepEqual(otherStore, [{ table: "widget", op: "insert", id: 20, shop_id: 2 }]);
  });

  it("says nothing about a write that rolled back", async () => {
    received = [];
    const client = await admin.connect();
    try {
      await client.query("begin");
      await client.query("insert into widget (id, shop_id, name) values (30, 1, 'never committed')");
      await settle();
      assert.deepEqual(received, [], "nothing is delivered before commit");
      await client.query("rollback");
    } finally {
      client.release();
    }
    await settle();
    assert.deepEqual(received, []);
  });

  it("fails the write when a notification carries a whole large row", async () => {
    await admin.query(`
      create table note (id bigserial primary key, shop_id bigint not null, body text);
      create function notify_whole_row() returns trigger language plpgsql as $$
      begin
        perform pg_notify('record_changes_rows', row_to_json(new)::text);
        return null;
      end; $$;
      create trigger note_notify after insert on note for each row execute function notify_whole_row();
    `);
    await assert.rejects(admin.query("insert into note (shop_id, body) values (1, repeat('x', 9000))"), /payload string too long/);
    const { rows } = await admin.query("select count(*)::int as count from note");
    assert.equal(rows[0].count, 0);
  });
});
