// What fly-io.md says about release_command, with Prisma 6.19.3 on a real Postgres:
// - without it (and with [processes] replacing docker-start) nothing runs migrations, and the app's
//   first query fails with P2021, the error fly-io/no-release-command quotes
// - a rollback with fly deploy --image runs the older image's release_command, and prisma migrate
//   deploy with fewer migrations than the database has applied exits 0, so it doesn't block the rollback
// Needs DATABASE_URL to be a superuser; skips without it. Run with: npm test (from this folder)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const here = import.meta.dirname;
const admin = process.env.DATABASE_URL;
const skip = admin ? false : "set DATABASE_URL to a Postgres superuser URL";
const prisma = join(here, "node_modules/.bin/prisma");

function databaseUrl(name: string) {
  const url = new URL(admin!);
  url.pathname = `/${name}`;
  return url.toString();
}

function sql(statement: string) {
  const result = spawnSync("psql", [admin!, "-qc", statement], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

describe("release_command and Prisma", { skip }, () => {
  const db = "fly_io_release";
  const dir = join(here, ".typecheck", "release");

  before(() => {
    sql(`drop database if exists ${db}`);
    sql(`create database ${db}`);
    rmSync(dir, { recursive: true, force: true });
    const schema = 'generator client {\n  provider = "prisma-client-js"\n}\n\ndatasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n\nmodel Session {\n  id   String  @id\n  shop String?\n}\n';
    for (const release of ["new", "old"]) {
      mkdirSync(join(dir, release, "prisma/migrations/1_init"), { recursive: true });
      writeFileSync(join(dir, release, "prisma/schema.prisma"), schema);
      writeFileSync(join(dir, release, "prisma/migrations/migration_lock.toml"), 'provider = "postgresql"\n');
      writeFileSync(join(dir, release, "prisma/migrations/1_init/migration.sql"), 'create table "Session" (id text primary key);\n');
    }
    mkdirSync(join(dir, "new/prisma/migrations/2_add_shop"), { recursive: true });
    writeFileSync(join(dir, "new/prisma/migrations/2_add_shop/migration.sql"), 'alter table "Session" add column shop text;\n');
    const generated = spawnSync(prisma, ["generate", "--schema", join(dir, "new/prisma/schema.prisma")], { encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);
  });

  after(() => sql(`drop database if exists ${db}`));

  it("fails the app's first query with P2021 before migrations run", () => {
    const script = `import { PrismaClient } from "@prisma/client";
const client = new PrismaClient();
try { await client.session.findFirst(); console.log("no error"); } catch (error) { console.log(error.code, error.message); }
await client.$disconnect();
`;
    writeFileSync(join(dir, "query.mjs"), script);
    const result = spawnSync(process.execPath, [join(dir, "query.mjs")], { encoding: "utf8", env: { ...process.env, DATABASE_URL: databaseUrl(db) } });
    assert.match(result.stdout, /P2021[\s\S]*The table `public\.Session` does not exist in the current database\./);
  });

  it("lets an older release's prisma migrate deploy pass after a newer one ran", () => {
    const env = { ...process.env, DATABASE_URL: databaseUrl(db) };
    const newer = spawnSync(prisma, ["migrate", "deploy", "--schema", join(dir, "new/prisma/schema.prisma")], { encoding: "utf8", env });
    assert.equal(newer.status, 0, newer.stdout + newer.stderr);
    const older = spawnSync(prisma, ["migrate", "deploy", "--schema", join(dir, "old/prisma/schema.prisma")], { encoding: "utf8", env });
    assert.equal(older.status, 0, older.stdout + older.stderr);
    assert.match(older.stdout, /No pending migrations to apply/);
  });
});
