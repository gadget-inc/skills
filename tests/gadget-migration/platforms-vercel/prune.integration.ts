// Runs pruneAuditLogs from references/platforms/vercel.md with Prisma through PgBouncer in transaction
// mode, as an app on Neon's pooled DATABASE_URL would, against the ScheduleRun model the reference shows.
// Needs DATABASE_URL for a Postgres superuser and PGBOUNCER_URL for a PgBouncer in transaction mode in
// front of it (any database name). Without both, the tests skip.
// Run with: DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres PGBOUNCER_URL=postgres://postgres:postgres@127.0.0.1:56432/postgres npm test
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { block } from "../platform-blocks.ts";
import { generatePrisma, here } from "./prisma.ts";

const ADMIN_URL = process.env.DATABASE_URL;
const POOLER_URL = process.env.PGBOUNCER_URL;
const withDatabase = (url: string, extra = "") => `${Object.assign(new URL(url), { pathname: "/vercel_it" })}${extra}`;

describe("pruneAuditLogs through a pooler in transaction mode", { skip: !(ADMIN_URL && POOLER_URL) && "set DATABASE_URL and PGBOUNCER_URL" }, () => {
  const direct = ADMIN_URL ? withDatabase(ADMIN_URL) : "";
  // pgbouncer=true turns off Prisma's prepared statements, as common.md describes
  const pooled = POOLER_URL ? withDatabase(POOLER_URL, `${POOLER_URL.includes("?") ? "&" : "?"}pgbouncer=true`) : "";
  const work = join(here, ".work/prune");
  let admin: pg.Client;
  let db: pg.Client;
  let prisma: any;
  let pruneAuditLogs: (executionId: string) => Promise<string>;
  const remaining = async () => Number((await db.query("select count(*) from audit_log")).rows[0].count);

  before(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query("drop database if exists vercel_it with (force)");
    await admin.query("create database vercel_it");
    generatePrisma();
    execFileSync(join(here, "node_modules/.bin/prisma"), ["db", "push", "--skip-generate", "--schema", "prisma/schema.prisma"], { cwd: here, env: { ...process.env, DATABASE_URL: direct, DATABASE_URL_UNPOOLED: direct }, stdio: "pipe" });
    db = new pg.Client({ connectionString: direct });
    await db.connect();
    await db.query("create table audit_log (id bigserial primary key, created_at timestamptz not null default now())");

    rmSync(work, { recursive: true, force: true });
    mkdirSync(join(work, "services"), { recursive: true });
    writeFileSync(join(work, "db.server.ts"), `import { PrismaClient } from "@prisma/client";\nexport default new PrismaClient({ datasourceUrl: ${JSON.stringify(pooled)} });\n`);
    // Node needs the file extension that the app's bundler adds
    writeFileSync(join(work, "services/audit-logs.server.ts"), block("vercel.md", "app/services/audit-logs.server.ts").replace('from "../db.server"', 'from "../db.server.ts"'));
    ({ pruneAuditLogs } = await import(join(work, "services/audit-logs.server.ts")));
    prisma = (await import(join(work, "db.server.ts"))).default;
  });

  after(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await admin?.query("drop database if exists vercel_it with (force)").catch(() => {});
    await admin?.end();
  });

  async function seed() {
    await db.query("truncate audit_log");
    await db.query("insert into audit_log (created_at) select now() - interval '100 days' from generate_series(1, 100)");
    await db.query("insert into audit_log (created_at) select now() from generate_series(1, 10)");
  }

  it("deletes once when one run is delivered twice at the same time", async () => {
    await seed();
    const results = await Promise.all([pruneAuditLogs("exec-1"), pruneAuditLogs("exec-1")]);
    assert.equal(results.filter((r) => r === "deleted 100 audit_log rows").length, 1, results.join(" / "));
    assert.ok(results.some((r) => r.startsWith("skipped:")), results.join(" / "));
    assert.equal(await remaining(), 10);
  });

  it("skips a later delivery of the same run", async () => {
    await seed();
    assert.equal(await pruneAuditLogs("exec-1"), "skipped: run exec-1 was already delivered");
    assert.equal(await remaining(), 110);
  });

  it("skips a run while the previous one still holds the lock", async () => {
    const holder = new pg.Client({ connectionString: direct });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended('schedule:prune-audit-logs', 0))");
      assert.equal(await pruneAuditLogs("exec-2"), "skipped: the previous run is still going");
      await holder.query("commit");
    } finally {
      await holder.end();
    }
    // the skipped run left no record, so a redelivery of it still runs
    assert.equal(await pruneAuditLogs("exec-2"), "deleted 100 audit_log rows");
  });

  it("rolls the run's record back with a failed delete, so a redelivery runs again", async () => {
    await seed();
    await db.query("alter table audit_log rename to audit_log_moved");
    await assert.rejects(pruneAuditLogs("exec-3"), /audit_log/);
    await db.query("alter table audit_log_moved rename to audit_log");
    assert.equal(Number((await db.query("select count(*) from schedule_run where execution_id = 'exec-3'")).rows[0].count), 0);
    assert.equal(await pruneAuditLogs("exec-3"), "deleted 100 audit_log rows");
  });

  it("shows the error Prisma's 5-second default transaction timeout gives", async () => {
    await assert.rejects(
      prisma.$transaction(async (tx: any) => {
        await tx.$executeRaw`select pg_sleep(5.5)`;
        await tx.$executeRaw`select 1`;
      }),
      (error: Error & { code?: string }) => error.code === "P2028" && /Transaction already closed: A query cannot be executed on an expired transaction\. The timeout for this transaction was 5000 ms/.test(error.message)
    );
  });
});
