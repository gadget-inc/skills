// Run with: node --test "tests/**/*.test.ts"
// The Supabase checks in scripts/checks/supabase.ts against fixtures/preflight/supabase-bad and
// supabase-good, and against the complete examples in references/platforms/supabase.md.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { openRepo, preflight } from "../../skills/gadget/gadget-migration/scripts/preflight.ts";
import { supabase } from "../../skills/gadget/gadget-migration/scripts/checks/supabase.ts";
import { platformBlocks } from "./platform-blocks.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/preflight/${name}`, import.meta.url));
const findings = (dir: string) => preflight(dir, ["supabase"]).findings.filter((f) => f.id.startsWith("supabase/"));
const bad = findings(fixture("supabase-bad"));
const good = findings(fixture("supabase-good"));

const temps: string[] = [];
function tempApp(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "supabase-preflight-"));
  temps.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const M = "supabase/migrations/";
// each check, the file and line it fires on in supabase-bad, and its severity
const EXPECTED: [string, string, number, string][] = [
  ["supabase/rls-missing", `${M}20261109000100_tables.sql`, 9, "error"],
  ["supabase/rls-missing", "prisma/migrations/20240530213853_create_session_table/migration.sql", 2, "error"],
  ["supabase/policy-without-role", `${M}20261109000100_tables.sql`, 18, "warning"],
  ["supabase/policy-without-role", `${M}20261109000250_notes.sql`, 12, "error"],
  ["supabase/policy-user-metadata", `${M}20261109000250_notes.sql`, 8, "error"],
  ["supabase/view-security-invoker", `${M}20261109000100_tables.sql`, 21, "error"],
  ["supabase/vector-grant", `${M}20261109000000_app_server_role.sql`, 1, "error"],
  ["supabase/cron-in-migration", `${M}20261109000300_cron.sql`, 4, "warning"],
  ["supabase/cron-http", `${M}20261109000300_cron.sql`, 4, "warning"],
  ["supabase/cron-history", `${M}20261109000300_cron.sql`, 4, "warning"],
  ["supabase/prisma-pgbouncer", ".env.example", 3, "error"],
  ["supabase/server-url-postgres", ".env.example", 3, "error"],
  ["supabase/db-push-local", "package.json", 7, "warning"],
  ["supabase/edge-function-shopify", "supabase/functions/sync-orders/index.ts", 3, "warning"],
  ["supabase/storage-sql-delete", "app/services/files.server.ts", 4, "error"],
  ["supabase/import-email-confirm", "scripts/import-users.ts", 9, "warning"],
];

describe("supabase checks on supabase-bad and supabase-good", () => {
  it("detects the app from its supabase folder", () => {
    assert.equal(supabase.detect(openRepo(fixture("supabase-bad"))), true);
  });

  for (const [id, file, line, severity] of EXPECTED) {
    it(`${id} fires at ${file}:${line} and not in supabase-good`, () => {
      const hit = bad.find((f) => f.id === id && f.file === file);
      assert.ok(hit, `${id} missing from ${JSON.stringify(bad.map((f) => [f.id, f.file, f.line]))}`);
      assert.equal(hit.line, line);
      assert.equal(hit.severity, severity);
      assert.ok(hit.fix.length > 0 && hit.message.length > 0);
      assert.ok(!good.some((f) => f.id === id), `${id} also fires in supabase-good`);
    });
  }

  it("reports nothing else in supabase-bad, and only the by-hand check in supabase-good", () => {
    const manual = (list: typeof bad) => list.filter((f) => f.severity === "manual").map((f) => f.id);
    assert.equal(bad.length - manual(bad).length, EXPECTED.length);
    assert.deepEqual(good.map((f) => f.id), ["supabase/data-api-grants"]);
    assert.deepEqual(manual(bad), ["supabase/data-api-grants"]);
  });

  it("names the access tokens when the exposed table is Prisma's Session", () => {
    const session = bad.find((f) => f.id === "supabase/rls-missing" && f.file?.startsWith("prisma/"))!;
    assert.match(session.message, /every store's Shopify access token/);
  });

  it("gives the error text for the failures it was reproduced with", () => {
    const text = (id: string) => bad.find((f) => f.id === id)?.error;
    assert.equal(text("supabase/vector-grant"), "operator does not exist: extensions.vector <=> unknown");
    assert.equal(text("supabase/prisma-pgbouncer"), 'prepared statement "s1" does not exist');
    assert.equal(text("supabase/storage-sql-delete"), "Direct deletion from storage tables is not allowed. Use the Storage API instead.");
    assert.equal(text("supabase/import-email-confirm"), "Email not confirmed");
  });
});

describe("supabase checks on the reference's complete examples", () => {
  it("finds nothing wrong in the migration set, the cron file, and the scripts", () => {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ dependencies: { "@prisma/client": "6.19.3", pg: "8.23.1", "@supabase/supabase-js": "2.119.0" } }),
      "prisma/migrations/20240530213853_create_session_table/migration.sql": 'CREATE TABLE "Session" ("id" TEXT NOT NULL, "accessToken" TEXT NOT NULL);\n',
    };
    for (const b of platformBlocks("supabase.md")) files[b.path] = b.code;
    assert.ok(Object.keys(files).some((p) => p.startsWith(M)), "no migration blocks found");
    assert.deepEqual(findings(tempApp(files)).filter((f) => f.severity !== "manual"), []);
  });
});

describe("supabase checks: edge cases", () => {
  const exposedTable = { [`${M}1_t.sql`]: "create table widget (id bigint primary key);\n" };

  it("treats a revoke from both Data API roles as locked down, and a revoke from one as open", () => {
    const both = findings(tempApp({ ...exposedTable, [`${M}2_r.sql`]: "revoke all on widget from anon, authenticated;\n" }));
    assert.ok(!both.some((f) => f.id === "supabase/rls-missing"));
    const one = findings(tempApp({ ...exposedTable, [`${M}2_r.sql`]: "revoke all on public.widget from anon;\n" }));
    assert.match(one.find((f) => f.id === "supabase/rls-missing")!.message, /isn't revoked from authenticated/);
  });

  it("skips the exposure checks when config.toml turns the Data API off or stops exposing new tables", () => {
    const off = findings(tempApp({ ...exposedTable, "supabase/config.toml": "[api]\nenabled = false\n" }));
    assert.deepEqual(off.map((f) => f.id), []);
    const noAuto = findings(tempApp({ ...exposedTable, "supabase/config.toml": "[api]\nenabled = true\nauto_expose_new_tables = false\n" }));
    assert.ok(!noAuto.some((f) => f.id === "supabase/rls-missing"));
    // an explicit grant still exposes the table
    const granted = findings(tempApp({ ...exposedTable, [`${M}2_g.sql`]: "grant select on widget to anon;\n", "supabase/config.toml": "[api]\nauto_expose_new_tables = false\n" }));
    assert.ok(granted.some((f) => f.id === "supabase/rls-missing"));
  });

  it("covers tables created after a default privileges revoke, and not those before it", () => {
    const out = findings(tempApp({
      [`${M}1_a.sql`]: "create table before_revoke (id bigint);\n",
      [`${M}2_b.sql`]: "alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;\n",
      [`${M}3_c.sql`]: "create table after_revoke (id bigint);\n",
    }));
    assert.deepEqual(out.filter((f) => f.id === "supabase/rls-missing").map((f) => f.message.split(" ")[0]), ["public.before_revoke"]);
  });

  it("ignores tables outside the exposed schemas, temporary tables, and statements in comments", () => {
    const out = findings(tempApp({
      [`${M}1_a.sql`]: "create schema private;\ncreate table private.secrets (id bigint);\ncreate temp table scratch (id bigint);\n-- create table commented (id bigint);\n/* create table also_commented (id bigint); */\n",
    }));
    assert.ok(!out.some((f) => f.id === "supabase/rls-missing"));
  });

  it("accepts a view made security_invoker by a later alter view", () => {
    const out = findings(tempApp({
      [`${M}1_a.sql`]: "create table audit_log (shop_id bigint);\nalter table audit_log enable row level security;\ncreate view audit_counts as select shop_id, count(*) from audit_log group by 1;\n",
      [`${M}2_b.sql`]: "alter view audit_counts set (security_invoker = on);\n",
    }));
    assert.ok(!out.some((f) => f.id === "supabase/view-security-invoker"));
  });

  it("reports a missing search_path alone as the operator error, and a missing grant alone as the permission error", () => {
    const base = "create extension vector with schema extensions;\ncreate role app_server login;\n";
    const noPath = findings(tempApp({ [`${M}1.sql`]: `${base}grant usage on schema extensions to app_server;\n` })).find((f) => f.id === "supabase/vector-grant")!;
    assert.equal(noPath.error, "operator does not exist: extensions.vector <=> unknown");
    const noGrant = findings(tempApp({ [`${M}1.sql`]: `${base}alter role app_server set search_path = "$user", public, extensions;\n` })).find((f) => f.id === "supabase/vector-grant")!;
    assert.equal(noGrant.error, "permission denied for schema extensions");
  });

  it("leaves Prisma URLs alone when the app uses the pg driver adapter", () => {
    const out = findings(tempApp({
      "package.json": JSON.stringify({ dependencies: { "@prisma/client": "6.19.3", "@prisma/adapter-pg": "6.19.3" } }),
      ".env.example": "DATABASE_URL=postgres://app_server.abc:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres\n",
    }));
    assert.ok(!out.some((f) => f.id === "supabase/prisma-pgbouncer"));
  });

  it("accepts supabase db push with --remote, and finds it in CI workflows", () => {
    const out = findings(tempApp({
      ".github/workflows/deploy.yml": "jobs:\n  migrate:\n    steps:\n      - run: supabase link --project-ref $REF\n      - run: supabase db push --remote\n      - run: supabase db push --include-all\n",
    }));
    assert.deepEqual(out.filter((f) => f.id === "supabase/db-push-local").map((f) => [f.file, f.line]), [[".github/workflows/deploy.yml", 6]]);
  });

  it("detects an app from a Supabase URL in its env example, and asks to check config.toml by hand when it can't be read", () => {
    const repo = openRepo(tempApp({ ".env.example": "DATABASE_URL=postgres://app_server.abc:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres\n" }));
    assert.equal(supabase.detect(repo), true);
    const out = findings(tempApp({ "supabase/config.toml": "[api\nenabled = true\n" }));
    assert.equal(out.find((f) => f.id === "supabase/config-unreadable")?.severity, "manual");
  });
});
