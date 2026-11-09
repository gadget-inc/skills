// Runs the row-level security policies in references/non-shopify-apps.md against Postgres, as a
// role that owns no tables, the way the reference says the app must connect.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { blocks, importBlock, sql } from "../coverage-snippets.ts";
import { scratchDatabase, skip } from "./db.ts";

let admin: pg.Pool;
let app: pg.Pool;
const SET_USER = sql("non-shopify-apps.md", "db/queries/set_current_user.sql");

// runs statements in one transaction as the given user, the way a request would
async function asUser<T>(userId: number | null, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await app.connect();
  try {
    await client.query("begin");
    if (userId !== null) await client.query(SET_USER, [String(userId)]);
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

const titles = async (client: pg.PoolClient, table: string) => (await client.query(`select body from ${table} order by id`)).rows.map((row) => row.body);

before(async () => {
  if (skip) return;
  let url: string;
  ({ admin, url } = await scratchDatabase("gadget_migration_user_tenancy_test"));
  await admin.query(`
    create table post (id bigint primary key, user_id bigint not null, body text);
    create table comment (id bigint primary key, post_id bigint not null, body text);
    insert into post values (1, 100, 'alice post'), (2, 200, 'bob post');
    insert into comment values (10, 1, 'on alice post'), (11, 2, 'on bob post');
    drop role if exists coverage_app_user;
    create role coverage_app_user login;
    grant select, insert, update, delete on post, comment to coverage_app_user;
  `);
  await admin.query(sql("non-shopify-apps.md", "db/migrations/post_owner_policy.sql"));
  await admin.query(sql("non-shopify-apps.md", "db/migrations/comment_owner_policy.sql"));
  const appUrl = new URL(url);
  appUrl.username = "coverage_app_user";
  app = new pg.Pool({ connectionString: appUrl.toString(), max: 1 }); // one connection, so leaks between requests would show
});

after(async () => {
  await app?.end();
  await admin?.end();
});

describe("non-shopify-apps.md row-level security", { skip }, () => {
  it("shows each user only their own posts", async () => {
    assert.deepEqual(await asUser(100, (client) => titles(client, "post")), ["alice post"]);
    assert.deepEqual(await asUser(200, (client) => titles(client, "post")), ["bob post"]);
  });

  it("returns no rows, and no error, when no user was set", async () => {
    assert.deepEqual(await asUser(null, (client) => titles(client, "post")), []);
  });

  it("does not carry a user over to the next request on the same connection", async () => {
    await asUser(100, (client) => titles(client, "post"));
    assert.deepEqual(await asUser(null, (client) => titles(client, "post")), []);
  });

  it("rejects a post written for another user", async () => {
    await assert.rejects(
      asUser(100, (client) => client.query("insert into post values (3, 200, 'forged')")),
      /row-level security policy/
    );
    await asUser(100, (client) => client.query("insert into post values (4, 100, 'alice second')"));
  });

  it("cannot update or delete another user's post", async () => {
    const updated = await asUser(100, (client) => client.query("update post set body = 'defaced' where id = 2"));
    const deleted = await asUser(100, (client) => client.query("delete from post where id = 2"));
    assert.equal(updated.rowCount, 0);
    assert.equal(deleted.rowCount, 0);
  });

  it("follows the relationship for comments", async () => {
    assert.deepEqual(await asUser(100, (client) => titles(client, "comment")), ["on alice post"]);
    await assert.rejects(
      asUser(100, (client) => client.query("insert into comment values (12, 2, 'on bob post, by alice')")),
      /row-level security policy/
    );
  });
});

describe("non-shopify-apps.md requireRole", () => {
  it("answers 401 without a user, 403 without the role, and passes with it", async () => {
    const { requireRole } = await importBlock(blocks("non-shopify-apps.md", "app/services/permissions.server.ts")[0]);
    assert.throws(() => requireRole(null, "admin"), (thrown: Response) => thrown.status === 401);
    assert.throws(() => requireRole({ roles: ["signed-in"] }, "admin"), (thrown: Response) => thrown.status === 403);
    assert.doesNotThrow(() => requireRole({ roles: ["signed-in", "admin"] }, "admin"));
  });
});
