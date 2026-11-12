// Run with: DATABASE_URL=... PGBOUNCER_URL=... PGBOUNCER_NO_PREPARED_URL=... REDIS_URL=... npm test
// The code and checks in references/platforms/common.md and scripts/db-check.sql, against real
// Postgres, PgBouncer, and Redis. Each part skips when its service isn't given.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { Queue } from "bullmq";
import { block, skillDir, typecheck, writeProject } from "../platform-blocks.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const { DATABASE_URL, PGBOUNCER_URL, PGBOUNCER_NO_PREPARED_URL, REDIS_URL } = process.env;
const dbCheck = join(skillDir, "scripts/db-check.sql");

// postgres://user:pass@host:port/name, through the given server URL, with PgBouncer's sslmode
function urlFor(server: string, database: string, user?: string, password?: string) {
  const url = new URL(server);
  url.pathname = `/${database}`;
  if (user) url.username = user;
  if (password) url.password = password;
  if (server === PGBOUNCER_URL || server === PGBOUNCER_NO_PREPARED_URL) url.searchParams.set("sslmode", "disable");
  return url.toString();
}

function psql(url: string, args: string[], options: { cwd?: string } = {}) {
  return spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-X", ...args], { encoding: "utf8", cwd: options.cwd });
}

function createDatabase(name: string) {
  const admin = urlFor(DATABASE_URL!, "postgres");
  psql(admin, ["-qc", `drop database if exists ${name} with (force)`]);
  const created = psql(admin, ["-qc", `create database ${name}`]);
  assert.equal(created.status, 0, created.stderr);
  return urlFor(DATABASE_URL!, name);
}

describe("common.md typechecks", () => {
  it("compiles every TypeScript block", () => {
    const roots = writeProject("common.md", join(here, ".typecheck"));
    typecheck(here, roots, { types: ["node"], lib: ["ES2023"] });
  });
});

describe("db-check.sql", { skip: !DATABASE_URL && "set DATABASE_URL to a superuser connection" }, () => {
  let url: string;
  before(() => {
    url = createDatabase("common_it_dbcheck");
    const setup = psql(url, [
      "-qc",
      `drop role if exists common_it_app;
       create role common_it_app login password 'pw' nosuperuser nobypassrls;
       create extension if not exists vector schema public;
       create table audit_log (id bigint primary key, shop_id bigint, embedding vector(3));
       alter table audit_log enable row level security;
       create policy audit_log_shop on audit_log to common_it_app using (shop_id = current_setting('app.shop_id')::bigint);
       create table widget (id bigint primary key);
       alter table widget enable row level security;
       grant select on all tables in schema public to common_it_app;`,
    ]);
    assert.equal(setup.status, 0, setup.stderr);
  });

  const rows = (output: string) =>
    Object.fromEntries(
      output
        .split("\n")
        .map((line) => line.split("|").map((cell) => cell.trim()))
        .filter((cells) => cells.length === 3 && cells[1] && cells[0] !== "check")
        .map(([check, status, detail]) => [check, { status, detail }])
    );

  it("reports a superuser that owns the tables", () => {
    const run = psql(url, ["-f", dbCheck]);
    assert.equal(run.status, 0, run.stderr);
    const result = rows(run.stdout);
    assert.equal(result["role bypasses row-level security"].status, "problem");
    assert.equal(result["owns tables with row-level security"].status, "problem");
    assert.match(result["owns tables with row-level security"].detail, /public\.audit_log, public\.widget/);
  });

  it("reports a table with no policy for the app's role", () => {
    const run = psql(urlFor(DATABASE_URL!, "common_it_dbcheck", "common_it_app", "pw"), ["-f", dbCheck]);
    const result = rows(run.stdout);
    assert.equal(result["role bypasses row-level security"].status, "ok");
    assert.equal(result["owns tables with row-level security"].status, "ok");
    assert.equal(result["tables with no policy for this role"].status, "problem");
    assert.match(result["tables with no policy for this role"].detail, /public\.widget/);
    assert.doesNotMatch(result["tables with no policy for this role"].detail, /audit_log/);
  });

  it("reports pgvector in a schema the role can't use or doesn't search", () => {
    const moved = psql(url, ["-qc", "create schema if not exists extensions; alter extension vector set schema extensions;"]);
    assert.equal(moved.status, 0, moved.stderr);
    const appUrl = urlFor(DATABASE_URL!, "common_it_dbcheck", "common_it_app", "pw");
    let result = rows(psql(appUrl, ["-f", dbCheck]).stdout);
    assert.equal(result["pgvector reachable"].status, "problem");
    assert.match(result["pgvector reachable"].detail, /grant usage on schema extensions to common_it_app/);

    psql(url, ["-qc", "grant usage on schema extensions to common_it_app"]);
    result = rows(psql(appUrl, ["-f", dbCheck]).stdout);
    assert.equal(result["pgvector reachable"].status, "problem");
    assert.match(result["pgvector reachable"].detail, /not on search_path/);

    psql(url, ["-qc", `alter role common_it_app set search_path = "$user", public, extensions`]);
    result = rows(psql(appUrl, ["-f", dbCheck]).stdout);
    assert.equal(result["pgvector reachable"].status, "ok");
  });

  it("sees a pooler in the way", { skip: !PGBOUNCER_URL && "set PGBOUNCER_URL" }, () => {
    const run = psql(urlFor(PGBOUNCER_URL!, "common_it_dbcheck", "common_it_app", "pw"), ["-f", dbCheck]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(rows(run.stdout).port.detail, /a pooler, proxy, or port mapping is in between/);
  });
});

describe("the one-transaction load script", { skip: (!DATABASE_URL || !PGBOUNCER_URL) && "set DATABASE_URL and PGBOUNCER_URL" }, () => {
  let dir: string;
  let pooled: string;
  before(() => {
    const direct = createDatabase("common_it_load");
    psql(direct, ["-qc", "create table widget (id bigint primary key, name text, created_at timestamptz, updated_at timestamptz)"]);
    pooled = urlFor(PGBOUNCER_URL!, "common_it_load");
    dir = mkdtempSync(join(tmpdir(), "common-load-"));
    writeFileSync(join(dir, "load.sql"), block("common.md", "scripts/load-widgets-pooled.sql"));
    const lines = [];
    for (let i = 1; i <= 2000; i++) lines.push(JSON.stringify({ id: String(i), name: i === 5 ? 'Blue "widget"\ttab \\ slash' : `w${i}`, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z" }));
    // a restarted export writes its last page twice
    lines.push(lines[1999].replace("w2000", "w2000 newer").replace("2026-01-02", "2026-01-03"));
    writeFileSync(join(dir, "widget.ndjson"), lines.join("\n") + "\n");
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("loads through PgBouncer in transaction mode, twice", () => {
    for (let run = 0; run < 2; run++) {
      const result = psql(pooled, ["-1", "-f", "load.sql"], { cwd: dir });
      assert.equal(result.status, 0, result.stderr);
    }
    const check = psql(pooled, ["-tAc", "select count(*), (select name from widget where id = 5), (select name from widget where id = 2000) from widget"]);
    assert.equal(check.stdout.trim(), '2000|Blue "widget"\ttab \\ slash|w2000 newer');
  });

  it("fails without psql -1", () => {
    const result = psql(pooled, ["-f", "load.sql"], { cwd: dir });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /relation "widget_import" does not exist/);
  });
});

describe("the pooler check", { skip: (!DATABASE_URL || !PGBOUNCER_URL || !PGBOUNCER_NO_PREPARED_URL) && "set DATABASE_URL, PGBOUNCER_URL, and PGBOUNCER_NO_PREPARED_URL" }, () => {
  let file: string;
  before(() => {
    createDatabase("common_it_pooler");
    mkdirSync(join(here, ".typecheck/scripts"), { recursive: true });
    file = join(here, ".typecheck/scripts/check-pooler.ts");
    writeFileSync(file, block("common.md", "scripts/check-pooler.ts"));
  });
  const run = (url: string) => spawnSync(process.execPath, ["--no-warnings", file], { encoding: "utf8", env: { ...process.env, DATABASE_URL: url } });

  it("passes through a pooler that keeps prepared statements", () => {
    const result = run(urlFor(PGBOUNCER_URL!, "common_it_pooler"));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /200 of 200 queries succeeded/);
  });

  it("fails through one that doesn't, and passes with pgbouncer=true", () => {
    const failing = run(urlFor(PGBOUNCER_NO_PREPARED_URL!, "common_it_pooler"));
    assert.equal(failing.status, 1);
    assert.match(failing.stdout, /prepared statement "s<n>" (does not exist|already exists)/);
    const fixed = new URL(urlFor(PGBOUNCER_NO_PREPARED_URL!, "common_it_pooler"));
    fixed.searchParams.set("pgbouncer", "true");
    assert.equal(run(fixed.toString()).status, 0);
  });
});

describe("Shopify's SQLite migration on Postgres", { skip: !DATABASE_URL && "set DATABASE_URL" }, () => {
  let dir: string;
  let url: string;
  const prisma = (args: string[]) =>
    spawnSync(join(here, "node_modules/.bin/prisma"), [...args, "--schema", join(dir, "prisma/schema.prisma")], { encoding: "utf8", env: { ...process.env, DATABASE_URL: url } });
  before(() => {
    url = createDatabase("common_it_prisma");
    dir = mkdtempSync(join(tmpdir(), "common-prisma-"));
    mkdirSync(join(dir, "prisma/migrations/20240530213853_create_session_table"), { recursive: true });
    const schema = readFileSync(join(here, "fixtures/template-schema.prisma"), "utf8");
    writeFileSync(join(dir, "prisma/schema.prisma"), schema);
    writeFileSync(join(dir, "prisma/migrations/20240530213853_create_session_table/migration.sql"), readFileSync(join(here, "fixtures/template-sqlite-migration.sql"), "utf8"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("fails the first deploy, blocks the next one, and recovers with migrate resolve", () => {
    const first = prisma(["migrate", "deploy"]);
    assert.notEqual(first.status, 0);
    assert.match(first.stdout + first.stderr, /type "datetime" does not exist/);

    // a Postgres migration history, as prisma migrate dev would write it
    rmSync(join(dir, "prisma/migrations"), { recursive: true });
    mkdirSync(join(dir, "prisma/migrations/20261110000000_init"), { recursive: true });
    const sql = prisma(["migrate", "diff", "--from-empty", "--to-schema-datamodel", join(dir, "prisma/schema.prisma"), "--script"]);
    writeFileSync(join(dir, "prisma/migrations/20261110000000_init/migration.sql"), sql.stdout);
    writeFileSync(join(dir, "prisma/migrations/migration_lock.toml"), 'provider = "postgresql"\n');

    const blocked = prisma(["migrate", "deploy"]);
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stdout + blocked.stderr, /P3009/);
    assert.match(blocked.stdout + blocked.stderr, /20240530213853_create_session_table/);

    assert.equal(prisma(["migrate", "resolve", "--rolled-back", "20240530213853_create_session_table"]).status, 0);
    const fixed = prisma(["migrate", "deploy"]);
    assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
  });

  it("refuses a migration_lock.toml that says sqlite", () => {
    writeFileSync(join(dir, "prisma/migrations/migration_lock.toml"), 'provider = "sqlite"\n');
    const run = prisma(["migrate", "deploy"]);
    assert.notEqual(run.status, 0);
    assert.match(run.stdout + run.stderr, /P3019/);
    assert.match(run.stdout + run.stderr, /does not match the one specified in the migration_lock\.toml/);
  });
});

describe("the BullMQ worker", { skip: !REDIS_URL && "set REDIS_URL to a Redis or Valkey that nothing else uses" }, () => {
  let dir: string;
  before(() => {
    // under this folder, so the bundle's external packages resolve from its node_modules
    dir = join(here, ".worker-build");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, "app/services"), { recursive: true });
    for (const path of ["app/queues.server.ts", "app/worker.server.ts", "app/entry.server.tsx"]) writeFileSync(join(dir, path), block("common.md", path));
    writeFileSync(
      join(dir, "app/services/external.server.ts"),
      'export async function notifyExternalSystem(orderId: string) {\n  console.log(`job ${orderId} started`);\n  await new Promise((r) => setTimeout(r, 2000));\n  console.log(`job ${orderId} finished`);\n}\n'
    );
    // the build:worker script from the reference, run as written
    const pkg = JSON.parse(block("common.md", "package.json").replace(/^\/\/.*\n/, ""));
    execFileSync(join(here, "node_modules/.bin/esbuild"), pkg.scripts["build:worker"].split(" ").slice(1), { cwd: dir });
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("finishes its running job on SIGTERM and exits 0", async () => {
    const queue = new Queue("external", { connection: { url: REDIS_URL } });
    await queue.obliterate({ force: true });
    const worker = spawn(process.execPath, ["build/worker.js"], { cwd: dir, env: { ...process.env, REDIS_URL } });
    let log = "";
    worker.stdout.on("data", (chunk) => (log += chunk));
    worker.stderr.on("data", (chunk) => (log += chunk));
    await queue.add("notify", { orderId: "11" });
    while (!log.includes("job 11 started")) await new Promise((r) => setTimeout(r, 50));
    const sentAt = Date.now();
    worker.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => worker.on("exit", resolve));
    assert.equal(code, 0, log);
    assert.ok(Date.now() - sentAt < 5000, "exits once the job is done");
    assert.match(log, /SIGTERM: taking no new jobs[\s\S]*job 11 finished/);
    assert.deepEqual(await queue.getJobCounts("completed", "active", "wait"), { completed: 1, active: 0, wait: 0 });
    await queue.obliterate({ force: true });
    await queue.close();
  });

  it("lets a web server that adds jobs exit on SIGTERM", async () => {
    // stands in for react-router-serve, which only closes its HTTP server on SIGTERM
    const server = (withHandler: boolean) =>
      [
        withHandler ? 'import "./app/entry.server";' : 'import { connection } from "./app/queues.server"; void connection;',
        'import { createServer } from "node:http";',
        "const server = createServer((_, res) => res.end()).listen(0);",
        'process.on("SIGTERM", () => server.close());',
        'console.log("listening");',
      ].join("\n");
    for (const withHandler of [true, false]) {
      writeFileSync(join(dir, "server.ts"), server(withHandler));
      // bundled the same way as the worker, which resolves the template's extensionless imports
      execFileSync(join(here, "node_modules/.bin/esbuild"), ["server.ts", "--bundle", "--platform=node", "--format=esm", "--packages=external", "--outfile=build/server.js"], { cwd: dir });
      const child = spawn(process.execPath, ["build/server.js"], { cwd: dir, env: { ...process.env, REDIS_URL } });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      while (!out.includes("listening")) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 500));
      child.kill("SIGTERM");
      const exited = await Promise.race([new Promise((r) => child.on("exit", () => r(true))), new Promise((r) => setTimeout(() => r(false), 4000))]);
      if (!exited) child.kill("SIGKILL");
      assert.equal(exited, withHandler, withHandler ? "exits with the handler" : "keeps running on the open Redis connection without it");
    }
  });
});
