// Prisma Migrate through a transaction-mode PgBouncer, as when Prisma's directUrl is Render's
// connectionPoolString, and the error an unmigrated database gives. Backs render/migrations-through-pool,
// render/no-migrations, and railway/direct-url-pooler.
//
// DATABASE_URL: a superuser on Postgres. PGBOUNCER_URL: a PgBouncer in transaction mode in front of the same
// server, such as postgres://postgres:postgres@127.0.0.1:6432/postgres?sslmode=disable. Skips without them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { PrismaClient } from "@prisma/client";

const { DATABASE_URL, PGBOUNCER_URL } = process.env;
const skip = DATABASE_URL && PGBOUNCER_URL ? false : "set DATABASE_URL and PGBOUNCER_URL";
const DATABASE = `render_migrations_${process.pid}`;
const EMPTY = `render_unmigrated_${process.pid}`;
const prismaBin = fileURLToPath(new URL("node_modules/.bin/prisma", import.meta.url));

let dir: string;
const urlFor = (base: string, database: string) => {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
};

async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// prisma migrate deploy with both of the schema's URLs set to one URL, as a Blueprint would set them
function migrate(url: string) {
  const run = spawnSync(prismaBin, ["migrate", "deploy", "--schema", join(dir, "schema.prisma")], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: url, DIRECT_DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
  });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

before(async () => {
  if (skip) return;
  await admin(async (client) => {
    for (const name of [DATABASE, EMPTY]) {
      await client.query(`drop database if exists ${name} with (force)`);
      await client.query(`create database ${name}`);
    }
  });
  mkdirSync(fileURLToPath(new URL(".run", import.meta.url)), { recursive: true });
  dir = mkdtempSync(fileURLToPath(new URL(".run/migrations-", import.meta.url)));
  mkdirSync(join(dir, "migrations/20261101000000_init"), { recursive: true });
  writeFileSync(
    join(dir, "schema.prisma"),
    `datasource db {\n  provider  = "postgresql"\n  url       = env("DATABASE_URL")\n  directUrl = env("DIRECT_DATABASE_URL")\n}\nmodel Session {\n  id   String @id\n  shop String\n}\n`
  );
  writeFileSync(join(dir, "migrations/migration_lock.toml"), 'provider = "postgresql"\n');
  writeFileSync(join(dir, "migrations/20261101000000_init/migration.sql"), 'CREATE TABLE "Session" ("id" TEXT NOT NULL PRIMARY KEY, "shop" TEXT NOT NULL);\n');
});

after(async () => {
  if (skip) return;
  // with (force) also ends the PgBouncer server connections that hold the lock
  await admin(async (client) => {
    for (const name of [DATABASE, EMPTY]) await client.query(`drop database if exists ${name} with (force)`);
  });
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("prisma migrate deploy through a transaction-mode pool", { skip }, () => {
  it("succeeds, leaves its advisory lock on a pooled server connection, and makes the next deploy fail with P1002", async () => {
    const pooled = urlFor(PGBOUNCER_URL!, DATABASE);
    const direct = urlFor(DATABASE_URL!, DATABASE);

    const first = migrate(pooled);
    assert.equal(first.status, 0, first.output);
    assert.match(first.output, /All migrations have been successfully applied/);

    const holders = await admin(async (client) => {
      const { rows } = await client.query(
        "select pid from pg_locks where locktype = 'advisory' and objid = 72707369 and granted and database = (select oid from pg_database where datname = $1)",
        [DATABASE]
      );
      return rows.map((r) => r.pid as number);
    });
    assert.equal(holders.length, 1, "Prisma exited, and a PgBouncer server connection still holds its lock");

    // even the direct URL waits for the lock, for Prisma's 10-second timeout
    const second = migrate(direct);
    assert.notEqual(second.status, 0);
    assert.match(second.output, /Error: P1002/);
    assert.match(second.output, /Timed out trying to acquire a postgres advisory lock \(SELECT pg_advisory_lock\(72707369\)\)\. Timeout: 10000ms\./);

    // the fix from render.md: end the session that holds the lock
    await admin((client) => client.query("select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and objid = 72707369"));
    const third = migrate(direct);
    assert.equal(third.status, 0, third.output);
    assert.match(third.output, /No pending migrations to apply/);
  });
});

describe("a database nothing migrated", { skip }, () => {
  it("fails the template's first session query with P2021", async () => {
    const prisma = new PrismaClient({ datasourceUrl: urlFor(DATABASE_URL!, EMPTY) });
    try {
      await assert.rejects(prisma.session.findMany(), (error: { code?: string; message: string }) => {
        assert.equal(error.code, "P2021");
        assert.match(error.message, /The table `public\.Session` does not exist in the current database\./);
        return true;
      });
    } finally {
      await prisma.$disconnect();
    }
  });
});
