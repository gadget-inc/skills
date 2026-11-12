// Runs the scheduled job in aws.md (app/jobs.server.ts and its migration) and the guide's app_user grants on
// PostgreSQL 18, with "postgres" created as RDS creates its master user: CREATEROLE and CREATEDB, not
// SUPERUSER or BYPASSRLS. The container's superuser is "superadmin", so the name is free. Needs Docker.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { block } from "../platform-blocks.ts";
import { docker, hasImage, removeContainer, waitFor } from "./docker.ts";

const here = import.meta.dirname;
const IMAGE = process.env.POSTGRES_IMAGE ?? "postgres:18";
const NAME = "migcheck-aws-postgres";
const PORT = 57211;
const url = (user: string, password: string, db = "shopify_app") => `postgresql://${user}:${password}@127.0.0.1:${PORT}/${db}`;

// the guide's Rewrite permissions and shop tenancy section, run as postgres
const GUIDE_ROLE_SQL = `
create role app_user login password 'a-long-random-password' nobypassrls;
grant select, insert, update, delete on all tables in schema public to app_user;
grant usage on all sequences in schema public to app_user;
alter default privileges for role postgres in schema public grant select, insert, update, delete on tables to app_user;
alter default privileges for role postgres in schema public grant usage on sequences to app_user;
`;

describe("the scheduled job on an RDS-like master user", { skip: !hasImage(IMAGE) && `needs Docker with ${IMAGE}` }, () => {
  let master: pg.Client;
  let prisma: any;
  let pruneAuditLogs: (scheduledTime: string) => Promise<string>;

  before(async () => {
    removeContainer(NAME);
    docker("run", "-d", "--name", NAME, "-e", "POSTGRES_USER=superadmin", "-e", "POSTGRES_PASSWORD=superadmin", "-p", `127.0.0.1:${PORT}:5432`, IMAGE);
    await waitFor(async () => {
      const c = new pg.Client({ connectionString: url("superadmin", "superadmin", "postgres") });
      await c.connect();
      await c.end();
      return true;
    }, "postgres");
    const admin = new pg.Client({ connectionString: url("superadmin", "superadmin", "postgres") });
    await admin.connect();
    await admin.query("create role postgres login password 'master-password' createrole createdb nosuperuser nobypassrls");
    await admin.query("create database shopify_app owner postgres");
    await admin.end();

    master = new pg.Client({ connectionString: url("postgres", "master-password") });
    await master.connect();
    // the table and the policy a migration from shop-tenancy.md creates, owned by the master user
    await master.query("create table audit_log (id bigserial primary key, shop_id bigint not null, created_at timestamptz not null)");
    await master.query("alter table audit_log enable row level security");
    await master.query("create policy audit_log_shop_isolation on audit_log using (shop_id = current_setting('app.shop_id')::bigint)");
    await master.query(GUIDE_ROLE_SQL);
    await master.query(block("aws.md", "prisma/migrations/20261112000000_schedule_run/migration.sql"));

    if (!existsSync(join(here, "node_modules/.prisma/client/index.js"))) {
      execFileSync(join(here, "node_modules/.bin/prisma"), ["generate", "--schema", "prisma/schema.prisma"], { cwd: here, stdio: "pipe" });
    }
    const work = join(here, ".work", "jobs");
    rmSync(work, { recursive: true, force: true });
    mkdirSync(join(work, "services"), { recursive: true });
    writeFileSync(join(work, "db.server.ts"), `import { PrismaClient } from "@prisma/client";\nexport default new PrismaClient({ datasourceUrl: ${JSON.stringify(url("app_user", "a-long-random-password"))} });\n`);
    writeFileSync(join(work, "services/reports.server.ts"), "export async function weeklyReport(_scheduledTime: string) {}\n");
    // Node needs the file extensions that the app's bundler adds
    writeFileSync(join(work, "jobs.server.ts"), block("aws.md", "app/jobs.server.ts").replace('from "./db.server"', 'from "./db.server.ts"').replace('from "./services/reports.server"', 'from "./services/reports.server.ts"'));
    ({ pruneAuditLogs } = await import(join(work, "jobs.server.ts")));
    prisma = (await import(join(work, "db.server.ts"))).default;
  });

  after(async () => {
    await prisma?.$disconnect();
    await master?.end();
    removeContainer(NAME);
  });

  const remaining = async () => (await master.query("select shop_id, created_at from audit_log order by id")).rows.map((r) => `${r.shop_id} ${r.created_at.toISOString()}`);

  it("can't make a BYPASSRLS role, and app_user can't delete across stores", async () => {
    await assert.rejects(master.query("create role maint login bypassrls"), (error: { message: string; detail?: string }) => {
      assert.equal(error.message, "permission denied to create role");
      assert.equal(error.detail, "Only roles with the BYPASSRLS attribute may create roles with the BYPASSRLS attribute.");
      return true;
    });
    const app = new pg.Client({ connectionString: url("app_user", "a-long-random-password") });
    await app.connect();
    try {
      await assert.rejects(app.query("delete from audit_log where created_at < now() - interval '90 days'"), /unrecognized configuration parameter "app\.shop_id"/);
    } finally {
      await app.end();
    }
  });

  it("deletes every store's rows older than 90 days before the scheduled time, once per run", async () => {
    await master.query(`insert into audit_log (shop_id, created_at) values
      (1, '2026-08-01T00:00:00Z'), (2, '2026-08-01T00:00:00Z'),
      (1, '2026-08-15T03:00:00Z'), (2, '2026-11-12T12:00:00Z')`);
    // a duplicate delivery at the same moment: one run deletes, the other skips
    const results = await Promise.all([pruneAuditLogs("2026-11-13T02:00:00Z"), pruneAuditLogs("2026-11-13T02:00:00Z")]);
    assert.ok(results.includes("deleted 2 audit_log rows for the run at 2026-11-13T02:00:00Z"), results.join(" | "));
    assert.ok(results.some((r) => r.startsWith("skipped:")), results.join(" | "));
    // 2026-08-15T03:00Z is 89.96 days before the scheduled time, so it stays however late the job runs
    assert.deepEqual(await remaining(), ["1 2026-08-15T03:00:00.000Z", "2 2026-11-12T12:00:00.000Z"]);
    assert.equal(await pruneAuditLogs("2026-11-13T02:00:00Z"), "skipped: the run for 2026-11-13T02:00:00Z already finished");
  });

  it("skips a run while another holds the lock, and runs it on the retry", async () => {
    const other = new pg.Client({ connectionString: url("app_user", "a-long-random-password") });
    await other.connect();
    try {
      await other.query("begin");
      await other.query("select pg_advisory_xact_lock(hashtextextended('schedule:prune-audit-logs', 0))");
      assert.equal(await pruneAuditLogs("2026-11-14T02:00:00Z"), "skipped: the previous run is still going");
      await other.query("commit");
    } finally {
      await other.end();
    }
    // a day later, the 2026-08-15 row is past 90 days too
    assert.equal(await pruneAuditLogs("2026-11-14T02:00:00Z"), "deleted 1 audit_log rows for the run at 2026-11-14T02:00:00Z");
    const runs = (await master.query("select scheduled_at from schedule_run order by scheduled_at")).rows.map((r) => r.scheduled_at.toISOString());
    assert.deepEqual(runs, ["2026-11-13T02:00:00.000Z", "2026-11-14T02:00:00.000Z"]);
  });

  it("refuses a job without a scheduled time", async () => {
    await assert.rejects(pruneAuditLogs("<aws.scheduler.scheduled-time>"), /no scheduled time in the job/);
  });
});
