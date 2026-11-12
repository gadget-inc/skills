// Runs against the full local Supabase stack (Auth, the Data API, Storage, and Supavisor): the
// import check script, the role password script through the pooler, and the failure signatures in
// references/platforms/supabase.md that need more than Postgres. Skipped unless SUPABASE_URL is set.
// Start the stack with this folder's supabase/config.toml, as tests/README.md describes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { sql, testDir, writeBlocks } from "./helpers.ts";

const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, SUPABASE_DB_URL, SUPABASE_POOLER_URL } = process.env;
const skip = !(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY && SUPABASE_SECRET_KEY && SUPABASE_DB_URL && SUPABASE_POOLER_URL) && "set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, SUPABASE_DB_URL, and SUPABASE_POOLER_URL from a local stack";
const dir = join(testDir, ".typecheck/run-stack");
const run = Date.now().toString(36);
let admin: pg.Pool;
let hash: string;

const options = { auth: { persistSession: false } };
const pooler = (user: string, password?: string, query = "") => {
  const url = new URL(SUPABASE_POOLER_URL!);
  url.username = user;
  url.password = password ?? "";
  url.search = query;
  return url.toString();
};
// the tenant part of the pooler's user name, "pooler-dev" on the local stack and the project ref when hosted
const tenant = () => decodeURIComponent(new URL(SUPABASE_POOLER_URL!).username).split(".")[1];

function runScript(path: string, env: Record<string, string>, cwd = dir) {
  const out = spawnSync(process.execPath, [join(dir, path)], { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
  return { code: out.status, stdout: out.stdout, stderr: out.stderr };
}

async function connectError(url: string): Promise<string> {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    await client.end();
    return "connected";
  } catch (error) {
    return (error as Error).message;
  }
}

// the Data API reloads its schema cache after DDL, a moment later
async function restGet(path: string): Promise<any> {
  for (let i = 0; i < 40; i++) {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: SUPABASE_PUBLISHABLE_KEY! } });
    const body = await response.json();
    if (body?.code !== "PGRST205") return body;
    await admin.query("notify pgrst, 'reload schema'");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${path} never appeared in the Data API's schema cache`);
}

before(async () => {
  if (skip) return;
  mkdirSync(dir, { recursive: true });
  writeBlocks(dir, ["scripts/verify-users.ts", "scripts/set-role-password.ts"]);
  admin = new pg.Pool({ connectionString: SUPABASE_DB_URL, max: 2 });
  // a bcrypt hash like the ones Gadget exports, made with pgcrypto
  hash = (await admin.query("select replace(extensions.crypt('correct horse', extensions.gen_salt('bf', 10)), '$2a$', '$2b$') as h")).rows[0].h;
  await admin.query(`do $$ begin create role app_server with login; exception when duplicate_object then null; end $$`);
  await admin.query("alter role app_server with password null");
});

after(async () => {
  await admin?.end();
});

describe("supabase.md on the local Supabase stack", () => {
  it("verify-users.ts reports missing and unconfirmed users, then passes once they're fixed", async (t) => {
    if (skip) return t.skip(skip);
    const supabase = createClient(SUPABASE_URL!, SUPABASE_SECRET_KEY!, options);
    const user = (n: number) => ({ id: `${run}${n}`, email: `${run}-${n}@example.com`, emailVerified: true });
    writeFileSync(join(dir, "user.ndjson"), [user(1), user(2), user(3)].map((u) => JSON.stringify(u)).join("\n") + "\n");
    // 1 imported as the guide's script does, 2 without email_confirm, 3 not at all
    assert.equal((await supabase.auth.admin.createUser({ email: user(1).email, password_hash: hash, email_confirm: true, app_metadata: { gadget_id: user(1).id } })).error, null);
    const second = await supabase.auth.admin.createUser({ email: user(2).email, password_hash: hash, app_metadata: { gadget_id: user(2).id } });
    const env = { SUPABASE_URL: SUPABASE_URL!, SUPABASE_SECRET_KEY: SUPABASE_SECRET_KEY!, SUPABASE_PUBLISHABLE_KEY: SUPABASE_PUBLISHABLE_KEY!, VERIFY_EMAIL: user(1).email, VERIFY_PASSWORD: "correct horse" };

    const first = runScript("scripts/verify-users.ts", env);
    assert.equal(first.code, 1, first.stderr);
    assert.match(first.stdout, /3 exported, 1 missing, 1 verified in Gadget but unconfirmed here/);
    assert.match(first.stdout, new RegExp(`missing: ${user(3).id}`));
    assert.match(first.stdout, new RegExp(`signed in; the token carries gadget_id ${user(1).id}`));

    await supabase.auth.admin.updateUserById(second.data.user!.id, { email_confirm: true });
    await supabase.auth.admin.createUser({ email: user(3).email, password_hash: hash, email_confirm: true, app_metadata: { gadget_id: user(3).id } });
    const fixed = runScript("scripts/verify-users.ts", env);
    assert.equal(fixed.code, 0, fixed.stdout + fixed.stderr);
    assert.match(fixed.stdout, /3 exported, 0 missing, 0 verified in Gadget but unconfirmed here/);
  });

  it("reproduces the import failure signatures", async (t) => {
    if (skip) return t.skip(skip);
    const supabase = createClient(SUPABASE_URL!, SUPABASE_SECRET_KEY!, options);
    const browser = createClient(SUPABASE_URL!, SUPABASE_PUBLISHABLE_KEY!, options);
    const email = (name: string) => `${run}-${name}@example.com`;
    assert.match((await supabase.auth.admin.createUser({ id: "42", email: email("id") })).error!.message, /ID must conform to the uuid v4 format/);
    await supabase.auth.admin.createUser({ email: email("unconfirmed"), password_hash: hash });
    assert.match((await browser.auth.signInWithPassword({ email: email("unconfirmed"), password: "correct horse" })).error!.message, /^Email not confirmed$/);
    await supabase.auth.admin.createUser({ email: email("as-password"), password: hash, email_confirm: true });
    assert.match((await browser.auth.signInWithPassword({ email: email("as-password"), password: "correct horse" })).error!.message, /^Invalid login credentials$/);
    const again = await supabase.auth.admin.createUser({ email: email("as-password"), password_hash: hash, email_confirm: true });
    assert.equal(again.error!.code, "email_exists");
    assert.match(again.error!.message, /A user with this email address has already been registered/);
    const bad = await supabase.auth.admin.createUser({ email: email("bad-hash"), password_hash: "not-a-hash", email_confirm: true });
    assert.equal(bad.error!.status, 500);
    assert.match(bad.error!.message, /Error creating user/);
  });

  it("exposes the template's Session table to the publishable key until the lock migration runs", async (t) => {
    if (skip) return t.skip(skip);
    await admin.query(`drop table if exists "Session"`);
    // created as postgres, as prisma migrate deploy does. A project that still exposes new tables
    // grants anon everything on it; grant it here too, in case this stack already ran the migration set
    await admin.query(readFileSync(join(testDir, "prisma/session-migration.sql"), "utf8"));
    await admin.query(`grant all on "Session" to anon, authenticated`);
    await admin.query(`insert into "Session" (id, shop, state, "accessToken") values ('offline_${run}.myshopify.com', '${run}.myshopify.com', 'x', 'shpat_example')`);
    const open = await restGet(`Session?select=shop,accessToken&shop=eq.${run}.myshopify.com`);
    assert.deepEqual(open, [{ shop: `${run}.myshopify.com`, accessToken: "shpat_example" }]);
    await admin.query(sql("prisma/migrations/<timestamp>_lock_session/migration.sql"));
    const locked = await restGet("Session?select=shop");
    assert.equal(locked.code, "42501");
    assert.match(locked.message, /permission denied for table Session/);
    await admin.query(`drop table "Session"`);
  });

  it("set-role-password.ts gives the role a password that signs in through Supavisor", async (t) => {
    if (skip) return t.skip(skip);
    // no password: the pooler can't use the role's secret, or, once it has cached an earlier one, rejects the login
    assert.match(await connectError(pooler(`app_server.${tenant()}`, "anything")), /\(EAUTHQUERY\) unsupported or invalid secret format|password authentication failed for user "app_server"/);
    const out = runScript("scripts/set-role-password.ts", { ADMIN_DATABASE_URL: SUPABASE_DB_URL!, POOLER_URL: pooler(`app_server.${tenant()}`, undefined, "?pgbouncer=true") });
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stderr, /signed in as app_server/);
    const url = out.stdout.trim().replace(/^DATABASE_URL=/, "");
    assert.match(url, /pgbouncer=true/);
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    assert.deepEqual((await client.query("select current_user")).rows, [{ current_user: "app_server" }]);
    await client.end();
    const password = new URL(url).password;
    assert.match(await connectError(pooler("app_server", password)), /\(ENOIDENTIFIER\) no tenant identifier provided \(external_id or sni_hostname required\)/);
    assert.match(await connectError(pooler("app_server.abcd", password)), /\(ENOTFOUND\) tenant\/user app_server\.abcd not found/);
    assert.match(await connectError(pooler(`app_server.${tenant()}`, "wrong")), /password authentication failed for user "app_server"/);
  });

  it("fails Prisma's prepared statements through the transaction pooler until the URL says pgbouncer=true", async (t) => {
    if (skip) return t.skip(skip);
    const attempt = async (url: string) => {
      const prisma = new PrismaClient({ datasourceUrl: url });
      const results = await Promise.allSettled(Array.from({ length: 100 }, (_, i) => prisma.$queryRaw`select ${i}::int as n`));
      await prisma.$disconnect();
      return results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => String(r.reason?.message));
    };
    const postgres = new URL(SUPABASE_POOLER_URL!);
    const failures = await attempt(postgres.toString());
    assert.ok(failures.length > 0);
    assert.ok(failures.every((m) => /prepared statement "s\d+" does not exist|prepared statement "s\d+" already exists/.test(m)), failures[0]);
    postgres.searchParams.set("pgbouncer", "true");
    assert.deepEqual(await attempt(postgres.toString()), []);
  });

  it("blocks deleting Storage rows with SQL", async (t) => {
    if (skip) return t.skip(skip);
    await admin.query("insert into storage.buckets (id, name) values ('widget-files', 'widget-files') on conflict do nothing");
    await assert.rejects(admin.query("delete from storage.objects where bucket_id = 'widget-files'"), /Direct deletion from storage tables is not allowed\. Use the Storage API instead\./);
  });
});
