// Builds and serves Shopify's React Router app on the Workers runtime with the files from
// references/platforms/cloudflare.md: workers/app.ts, app/entry.server.tsx, vite.config.ts, wrangler.jsonc,
// and app/services/files.server.ts. app-fixture/ holds the rest of the app: the guide's withDb,
// workerSessionStorage, ShopGate, ProcessWebhook, ReconcileShop, and queue consumer, a PruneAuditLogs
// Workflow, and services that record what ran in Postgres. Routes under app/routes/test.* exist only here.
//
// Needs DATABASE_URL for a Postgres superuser with a password, because Hyperdrive's local connection
// string must have one. Without it, only the typecheck, build, and dry-run tests run.
// Run with: DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm test
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { block } from "../platform-blocks.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const app = join(here, ".work/app");
const bin = (name: string) => join(here, "node_modules/.bin", name);
const PORT = Number(process.env.CLOUDFLARE_TEST_PORT ?? 57320);
const DEV_PORT = PORT + 1;
const ADMIN_URL = process.env.DATABASE_URL;
const hasPassword = !!ADMIN_URL && !!new URL(ADMIN_URL).password;
const databaseUrl = ADMIN_URL ? Object.assign(new URL(ADMIN_URL), { pathname: "/cloudflare_it" }).toString() : "";
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", FORCE_COLOR: "0" };

// the reference's files, written over a copy of app-fixture
const FROM_REFERENCE = ["workers/app.ts", "app/entry.server.tsx", "vite.config.ts", "wrangler.jsonc", "app/services/files.server.ts"];

function sh(command: string, args: string[], extraEnv: Record<string, string> = {}) {
  const result = spawnSync(command, args, { cwd: app, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 300_000 });
  return { status: result.status, output: `${result.stdout}${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, "") };
}

function assemble() {
  rmSync(join(here, ".work"), { recursive: true, force: true });
  cpSync(join(here, "app-fixture"), app, { recursive: true });
  for (const path of FROM_REFERENCE) {
    mkdirSync(dirname(join(app, path)), { recursive: true });
    // fill in the account id, as a reader would, so R2_ENDPOINT is a URL
    writeFileSync(join(app, path), block("cloudflare.md", path).replaceAll("<account id>", ACCOUNT_ID));
  }
  writeFileSync(join(app, ".dev.vars"), "SHOPIFY_API_SECRET=hush\nR2_ACCESS_KEY_ID=r2localkey\nR2_SECRET_ACCESS_KEY=r2localsecret\nR2_ENDPOINT=http://127.0.0.1:57310\n");
}

describe("the reference's files in Shopify's template, type-checked and built", () => {
  before(assemble);

  it("typechecks the whole app after wrangler types --env production --strict-vars=false", () => {
    assert.equal(sh(bin("wrangler"), ["types", "--env", "production", "--strict-vars=false"]).status, 0);
    assert.equal(sh(bin("react-router"), ["typegen"]).status, 0);
    const tsc = sh(bin("tsc"), ["--noEmit", "-p", "."]);
    assert.equal(tsc.status, 0, tsc.output);
  });

  it("fails tsc with possibly undefined bindings after wrangler types without --env", () => {
    sh(bin("wrangler"), ["types"]);
    const tsc = sh(bin("tsc"), ["--noEmit", "-p", "."]);
    assert.notEqual(tsc.status, 0);
    assert.match(tsc.output, /error TS18048: 'env\.HYPERDRIVE' is possibly 'undefined'\./);
  });

  it("fails tsc on vite.config.ts when vars get literal types", () => {
    sh(bin("wrangler"), ["types", "--env", "production"]);
    const tsc = sh(bin("tsc"), ["--noEmit", "-p", "."]);
    assert.match(tsc.output, /vite\.config\.ts\(\d+,\d+\): error TS2322: Type 'string' is not assignable to type '"https:\/\/app\.example\.com"'\./);
    sh(bin("wrangler"), ["types", "--env", "production", "--strict-vars=false"]);
  });

  it("refuses a build without CLOUDFLARE_ENV", () => {
    const build = sh(bin("react-router"), ["build"]);
    assert.notEqual(build.status, 0);
    assert.match(build.output, /set CLOUDFLARE_ENV to staging or production when you build/);
  });

  it("dry-runs the production build with production's resources", () => {
    assert.equal(sh(bin("react-router"), ["build"], { CLOUDFLARE_ENV: "production" }).status, 0);
    const dry = sh(bin("wrangler"), ["deploy", "--dry-run"]);
    assert.equal(dry.status, 0, dry.output);
    for (const binding of ["env.HYPERDRIVE (<production Hyperdrive id>)", "env.EXTERNAL_QUEUE (my-app-external)", "env.FILES (my-app-files)", "env.PRUNE_AUDIT_LOGS (PruneAuditLogs)", "env.SHOP_GATE (ShopGate)"]) {
      assert.ok(dry.output.includes(binding), `missing ${binding} in:\n${dry.output}`);
    }
    assert.doesNotMatch(dry.output, /WARNING/);
  });

  it("refuses to deploy that build as staging", () => {
    const dry = sh(bin("wrangler"), ["deploy", "--dry-run", "--env", "staging"]);
    assert.notEqual(dry.status, 0);
    assert.match(dry.output, /You have specified the environment "staging" via the `--env\/-e` CLI argument\.\s+This does not match the target environment "production" that was used when building the application\./);
  });

  it("dry-runs the staging build with staging's resources", () => {
    assert.equal(sh(bin("react-router"), ["build"], { CLOUDFLARE_ENV: "staging" }).status, 0);
    const dry = sh(bin("wrangler"), ["deploy", "--dry-run"]);
    assert.equal(dry.status, 0, dry.output);
    assert.ok(dry.output.includes("env.EXTERNAL_QUEUE (my-app-staging-external)"), dry.output);
    assert.ok(dry.output.includes('env.SHOPIFY_APP_URL ("https://staging.example.com")'), dry.output);
    const built = JSON.parse(readFileSync(join(app, "build/server/wrangler.json"), "utf8"));
    assert.equal(built.name, "my-app-staging");
    assert.deepEqual(built.triggers.crons, ["0 2 * * *", "0 * * * *"]);
    assert.deepEqual(built.placement, { region: "aws:us-east-1" });
  });
});

describe("the staging build served by the Vite plugin against local Postgres", { skip: !hasPassword && "set DATABASE_URL to a superuser URL with a password" }, () => {
  let server: ChildProcess | undefined;
  let admin: pg.Client;
  let db: pg.Client;
  const base = `http://127.0.0.1:${PORT}`;

  const count = async (sql: string) => Number((await db.query(sql)).rows[0].count);
  async function until(check: () => Promise<boolean>, what: string, ms = 30_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.fail(`timed out waiting for ${what}`);
  }
  async function instances(workflow: string): Promise<string[]> {
    const res = await fetch(`${base}/cdn-cgi/local/explorer/api/workflows/${workflow}/instances`);
    return ((await res.json()) as any).result.map((i: { id: string }) => i.id);
  }
  function webhook(webhookId: string, secret = "hush") {
    const body = JSON.stringify({ id: 820982911946154500, line_items: [] });
    return fetch(`${base}/webhooks/orders/create`, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-shopify-hmac-sha256": createHmac("sha256", secret).update(body).digest("base64"),
        "x-shopify-topic": "orders/create",
        "x-shopify-shop-domain": "example.myshopify.com",
        "x-shopify-webhook-id": webhookId,
        "x-shopify-api-version": "2026-10",
        "x-shopify-event-id": randomUUID(),
        "x-shopify-triggered-at": new Date().toISOString(),
      },
    });
  }

  before(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query("drop database if exists cloudflare_it with (force)");
    await admin.query("create database cloudflare_it");
    db = new pg.Client({ connectionString: databaseUrl });
    await db.connect();
    await db.query(`
      create table shopify_session (id text primary key, shop text not null, properties jsonb not null);
      create index on shopify_session (shop);
      create table webhook_log (id bigserial primary key, shop text, topic text, payload jsonb);
      create table external_log (id bigserial primary key, shop_id text, order_id text);
      create table reconcile_log (id bigserial primary key, shop text);
      create table audit_log (id bigserial primary key, created_at timestamptz not null default now());
    `);
    if (sh(bin("react-router"), ["build"], { CLOUDFLARE_ENV: "staging" }).status !== 0) throw new Error("staging build failed");
    server = spawn(bin("vite"), ["preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
      cwd: app,
      env: { ...env, CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: databaseUrl },
      stdio: "ignore",
    });
    await until(async () => fetch(`${base}/test/env`).then((r) => r.ok, () => false), "the preview server", 60_000);
  });

  after(async () => {
    server?.kill();
    await db?.end();
    await admin?.query("drop database if exists cloudflare_it with (force)").catch(() => {});
    await admin?.end();
  });

  it("renders a page with renderToReadableStream and the template's Shopify headers", async () => {
    const res = await fetch(`${base}/?shop=example.myshopify.com`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /rendered on Workers with 0 sessions/);
    assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors https:\/\/example\.myshopify\.com/);
    const bot = await fetch(`${base}/`, { headers: { "user-agent": "Googlebot/2.1" } });
    assert.equal(bot.status, 200);
  });

  it("answers both deliveries of one webhook and runs one Workflow", async () => {
    const [first, second] = await Promise.all([webhook("delivery-1"), webhook("delivery-1")]);
    assert.deepEqual([first.status, second.status], [200, 200]);
    await until(async () => (await count("select count(*) from webhook_log")) === 1, "the webhook Workflow");
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(await count("select count(*) from webhook_log"), 1);
    assert.deepEqual(await instances("my-app-staging-process-webhook"), ["delivery-1"]);
  });

  it("rejects a webhook with a bad signature", async () => {
    assert.equal((await webhook("delivery-2", "not-the-secret")).status, 401);
  });

  it("prunes old audit_log rows in batches from the 0 2 * * * cron, once a day", async () => {
    await db.query("insert into audit_log (created_at) select now() - interval '100 days' from generate_series(1, 12000)");
    await db.query("insert into audit_log (created_at) select now() from generate_series(1, 10)");
    const res = await fetch(`${base}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("0 2 * * *")}`, { method: "POST" });
    assert.equal(res.status, 200);
    await until(async () => (await count("select count(*) from audit_log")) === 10, "the prune Workflow");
    await fetch(`${base}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("0 2 * * *")}`, { method: "POST" });
    const ids = await instances("my-app-staging-prune-audit-logs");
    assert.equal(ids.length, 1);
    assert.match(ids[0], /^prune-audit-logs-\d{4}-\d{2}-\d{2}$/);
  });

  it("starts one ReconcileShop per store from the hourly cron, with ids an instance can take", async () => {
    await db.query("insert into shopify_session values ('offline_a.myshopify.com', 'a.myshopify.com', '[]'), ('offline_b.myshopify.com', 'b.myshopify.com', '[]')");
    assert.equal((await fetch(`${base}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("0 * * * *")}`, { method: "POST" })).status, 200);
    await until(async () => (await count("select count(*) from reconcile_log")) === 2, "two ReconcileShop instances");
    const ids = (await instances("my-app-staging-reconcile-shop")).sort();
    assert.equal(ids.length, 2);
    assert.match(ids[0], /^reconcile-a-myshopify-com-\d{4}-\d{2}-\d{2}T\d{2}$/);
  });

  it("fails a cron it has no case for", async () => {
    const res = await fetch(`${base}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("0 9 * * MON")}`, { method: "POST" });
    assert.equal(res.status, 500);
  });

  it("runs queued jobs through the consumer", async () => {
    assert.equal((await fetch(`${base}/test/enqueue?shop=a.myshopify.com&n=5`)).status, 200);
    await until(async () => (await count("select count(*) from external_log")) === 5, "5 consumed jobs");
  });

  it("signs an R2 upload inside the Workers runtime", async () => {
    const { url, key } = (await (await fetch(`${base}/test/upload`)).json()) as { url: string; key: string };
    const params = new URL(url).searchParams;
    assert.equal(params.get("X-Amz-SignedHeaders"), "content-length;content-type;host");
    assert.equal(params.get("X-Amz-Expires"), "900");
    assert.match(key, /^shops\/7\/widgets\/42\/manual\/[0-9a-f-]{36}-guide\.pdf$/);
    // vite preview runs the build, which keeps only the secrets.required names from .dev.vars, so the var from wrangler.jsonc wins
    assert.ok(url.startsWith(`https://${ACCOUNT_ID}.r2.cloudflarestorage.com/my-app-staging-files/shops/7/widgets/42/manual/`), url);
  });

  it("passes the Shopify CLI's tunnel URL to the Worker under the dev server, and keeps it out of builds", async () => {
    const dev = spawn(bin("react-router"), ["dev", "--port", String(DEV_PORT), "--strictPort", "--host", "127.0.0.1"], {
      cwd: app,
      env: { ...env, CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: databaseUrl, SHOPIFY_APP_URL: "https://tunnel.example.com" },
      stdio: "ignore",
    });
    try {
      let seen: unknown;
      await until(async () => {
        seen = await fetch(`http://127.0.0.1:${DEV_PORT}/test/env`).then((r) => (r.ok ? r.json() : null), () => null);
        return !!seen;
      }, "the dev server", 90_000);
      // the dev server reads all of .dev.vars, so R2_ENDPOINT points at the local S3 server
      assert.deepEqual(seen, { SHOPIFY_APP_URL: "https://tunnel.example.com", R2_ENDPOINT: "http://127.0.0.1:57310" });
    } finally {
      dev.kill();
    }
    assert.deepEqual(await (await fetch(`${base}/test/env`)).json(), { SHOPIFY_APP_URL: "https://staging.example.com", R2_ENDPOINT: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com` });
  });
});
