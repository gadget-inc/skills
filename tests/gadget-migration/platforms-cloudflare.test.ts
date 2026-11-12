// Run with: node --test "tests/**/*.test.ts"
// The Cloudflare checks in scripts/checks/cloudflare.ts against fixtures/preflight/cloudflare-bad and
// cloudflare-good, and the files in references/platforms/cloudflare.md against the same checks.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { preflight } from "../../skills/gadget/gadget-migration/scripts/preflight.ts";
import { parseJsoncWithLines } from "../../skills/gadget/gadget-migration/scripts/checks/read-config.ts";
import { block } from "./platform-blocks.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/preflight/${name}`, import.meta.url));
const cloudflareFindings = (dir: string) => preflight(dir, ["cloudflare"]).findings.filter((f) => f.id.startsWith("cloudflare/"));
const where = (f: { id: string; file?: string; line?: number }) => `${f.id} ${f.file}:${f.line}`;

const temps: string[] = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function tempDir(from?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cloudflare-preflight-"));
  temps.push(dir);
  if (from) cpSync(fixture(from), dir, { recursive: true });
  return dir;
}
function write(dir: string, path: string, text: string) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

describe("parseJsoncWithLines", () => {
  it("reads comments and trailing commas and remembers the line of every key", () => {
    const text = ['{', '  // a comment with "quotes" and , commas', '  "name": "my-app", /* inline */', '  "env": {', '    "staging": { "vars": { "URL": "https://a//b" }, },', "  },", "}"].join("\n");
    const config = parseJsoncWithLines(text);
    assert.equal(config.name, "my-app");
    assert.equal(config.env.staging.vars.URL, "https://a//b");
  });

  it("fails with a line number on broken input", () => {
    assert.throws(() => parseJsoncWithLines('{\n  "name": "my-app"\n  "main": "x"\n}'), /line 3/);
  });
});

describe("Cloudflare checks on cloudflare-bad", () => {
  const findings = cloudflareFindings(fixture("cloudflare-bad"));
  const expected: [string, "error" | "warning" | "manual", string, number][] = [
    // "vars" at the top, missing from env.staging
    ["cloudflare/env-not-inherited", "error", "wrangler.jsonc", 19],
    // production's Hyperdrive id is the top level's, and staging's queue is production's
    ["cloudflare/shared-resource-name", "error", "wrangler.jsonc", 11],
    ["cloudflare/shared-resource-name", "error", "wrangler.jsonc", 22],
    ["cloudflare/cron-weekday", "warning", "wrangler.jsonc", 12],
    ["cloudflare/crons-before-cutover", "manual", "wrangler.jsonc", 12],
    ["cloudflare/queue-max-retries", "warning", "wrangler.jsonc", 15],
    ["cloudflare/no-placement", "warning", "wrangler.jsonc", 7],
    ["cloudflare/hyperdrive-caching", "manual", "wrangler.jsonc", 8],
    ["cloudflare/r2-cors", "manual", "wrangler.jsonc", 8],
    // "deploy" builds with no environment and vite.config.ts doesn't require one, "deploy:production" builds staging
    ["cloudflare/build-env-mismatch", "warning", "package.json", 7],
    ["cloudflare/build-env-mismatch", "error", "package.json", 8],
    ["cloudflare/types-strict-vars", "warning", "vite.config.ts", 7],
    ["cloudflare/types-without-env", "warning", "worker-configuration.d.ts", 5],
    ["cloudflare/prisma-client", "error", "app/db.server.ts", 1],
    ["cloudflare/entry-pipeable-stream", "error", "app/entry.server.tsx", 2],
    ["cloudflare/long-running-worker", "error", "app/jobs.server.ts", 4],
    ["cloudflare/module-scope-client", "error", "app/pg.server.ts", 4],
    ["cloudflare/webhook-waituntil", "warning", "app/routes/webhooks.orders.create.tsx", 7],
    ["cloudflare/r2-dev-url", "warning", "app/services/files.server.ts", 2],
    ["cloudflare/kv-session-storage", "warning", "app/sessions.server.ts", 1],
    ["cloudflare/postgres-session-storage", "error", "app/shopify.server.ts", 8],
  ];

  for (const [id, severity, file, line] of expected) {
    it(`reports ${id} at ${file}:${line}`, () => {
      const found = findings.find((f) => f.id === id && f.file === file && f.line === line);
      assert.ok(found, `missing ${id} at ${file}:${line}; got:\n${findings.map(where).join("\n")}`);
      assert.equal(found.severity, severity);
      assert.ok(found.fix.length > 0 && found.message.length > 0);
      assert.match(found.docs ?? "", /^https:\/\/docs\.gadget\.dev\/guides\/moving-to-another-platform\/cloudflare#/);
    });
  }

  it("reports nothing else", () => {
    assert.equal(findings.length, expected.length, findings.map(where).join("\n"));
  });

  it("gives the error text a reader will see", () => {
    const text = (id: string, file?: string) => findings.find((f) => f.id === id && (!file || f.file === file))?.error;
    assert.equal(text("cloudflare/env-not-inherited"), '"vars" exists at the top level, but not on "env.staging".');
    assert.equal(text("cloudflare/entry-pipeable-stream"), "TypeError: server_browserExports.renderToPipeableStream is not a function");
    assert.equal(text("cloudflare/prisma-client"), 'Error: No such module "assets/.prisma/client/default".');
    assert.match(text("cloudflare/postgres-session-storage") ?? "", /^Disallowed operation called within global scope\./);
    assert.match(text("cloudflare/module-scope-client") ?? "", /^Disallowed operation called within global scope\./);
    assert.equal(
      findings.find((f) => f.id === "cloudflare/build-env-mismatch" && f.line === 8)?.error,
      'You have specified the environment "production" via the `--env/-e` CLI argument. This does not match the target environment "staging" that was used when building the application.'
    );
    assert.equal(findings.find((f) => f.id === "cloudflare/build-env-mismatch" && f.line === 7)?.error, "No bindings found.");
    assert.equal(text("cloudflare/types-without-env"), "error TS18048: 'env.HYPERDRIVE' is possibly 'undefined'.");
  });

  it("drops the common findings Workers make moot", () => {
    const all = preflight(fixture("cloudflare-bad"), ["cloudflare"]).findings.map((f) => f.id);
    const commonOnly = preflight(fixture("cloudflare-bad"), []).findings.map((f) => f.id);
    // the BullMQ worker has no SIGTERM handler, but on Workers it has nowhere to run at all
    assert.ok(commonOnly.includes("common/worker-sigterm"));
    assert.ok(!all.includes("common/worker-sigterm"));
  });
});

describe("Cloudflare detection and the common findings it drops", () => {
  // the template's files that only fail on Workers, and a BullMQ worker with no SIGTERM handler
  function nodeApp(dir: string) {
    write(dir, "app/entry.server.tsx", 'import { renderToPipeableStream } from "react-dom/server";\nexport default renderToPipeableStream;\n');
    write(dir, "app/db.server.ts", 'import { PrismaClient } from "@prisma/client";\nexport default new PrismaClient();\n');
    write(dir, "app/worker.server.ts", 'import { Worker } from "bullmq";\nconst worker = new Worker("external", async () => {}, { connection: { url: process.env.REDIS_URL } });\n');
  }

  it("doesn't claim a Fly.io app that installs wrangler only to manage R2 buckets", () => {
    const dir = tempDir();
    nodeApp(dir);
    write(dir, "fly.toml", 'app = "my-app"\n');
    write(dir, "package.json", JSON.stringify({ scripts: { "r2:cors": "wrangler r2 bucket cors set my-app-files --file r2-cors.json" }, dependencies: { "@prisma/client": "6.19.3", bullmq: "5.61.0" }, devDependencies: { wrangler: "4.160.0" } }, null, 2));
    const { platforms, findings } = preflight(dir);
    assert.ok(!platforms.some((p) => p.platform === "cloudflare"), platforms.map((p) => p.platform).join(","));
    assert.deepEqual(findings.filter((f) => f.id.startsWith("cloudflare/")).map(where), []);
    // nothing drops the worker's missing SIGTERM handler, which matters on Fly.io
    assert.ok(findings.some((f) => f.id === "common/worker-sigterm"));
  });

  it("claims an app with a wrangler config or the Vite plugin", () => {
    for (const files of [{ "wrangler.jsonc": '{ "name": "my-app" }' }, { "package.json": JSON.stringify({ devDependencies: { "@cloudflare/vite-plugin": "1.68.0" } }) }] as Record<string, string>[]) {
      const dir = tempDir();
      write(dir, "package.json", "{}");
      for (const [path, text] of Object.entries(files)) write(dir, path, text);
      assert.ok(preflight(dir).platforms.some((p) => p.platform === "cloudflare"), Object.keys(files).join(","));
    }
  });

  it("keeps the worker's common findings, and only warns about the worker, when another host can run it", () => {
    const dir = tempDir();
    nodeApp(dir);
    write(dir, "wrangler.jsonc", '{ "name": "my-app", "main": "workers/app.ts" }');
    write(dir, "fly.toml", 'app = "my-app-worker"\n');
    write(dir, "package.json", JSON.stringify({ dependencies: { bullmq: "5.61.0" }, devDependencies: { wrangler: "4.160.0" } }));
    const findings = preflight(dir).findings;
    assert.equal(findings.find((f) => f.id === "cloudflare/long-running-worker")?.severity, "warning");
    assert.match(findings.find((f) => f.id === "cloudflare/long-running-worker")!.message, /fly\.toml/);
    assert.ok(findings.some((f) => f.id === "common/worker-sigterm"));
  });

  it("ignores a note about renderToPipeableStream in a comment", () => {
    const dir = tempDir();
    write(dir, "wrangler.jsonc", '{ "name": "my-app" }');
    write(dir, "package.json", "{}");
    write(dir, "app/entry.server.tsx", '// Workers have no Node streams, so this renders with renderToReadableStream, not renderToPipeableStream\nimport { renderToReadableStream } from "react-dom/server";\n');
    assert.deepEqual(cloudflareFindings(dir).map(where), []);
  });
});

describe("cloudflare/build-env-mismatch", () => {
  // the reference's vite.config.ts, which stops a build without CLOUDFLARE_ENV
  const guarded = () => block("cloudflare.md", "vite.config.ts");
  function app(scripts: Record<string, string>, vite?: string) {
    const dir = tempDir("cloudflare-good");
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    pkg.scripts = scripts;
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
    if (vite) write(dir, "vite.config.ts", vite);
    return cloudflareFindings(dir).filter((f) => f.id === "cloudflare/build-env-mismatch");
  }

  it("accepts a deploy script meant to run as CLOUDFLARE_ENV=staging npm run deploy:worker when vite.config requires it", () => {
    assert.deepEqual(app({ build: "react-router build", "deploy:worker": "npm run build && wrangler deploy" }, guarded()).map(where), []);
  });

  it("warns about the same script when nothing stops a build without CLOUDFLARE_ENV", () => {
    const found = app({ build: "react-router build", "deploy:worker": "npm run build && wrangler deploy" });
    assert.deepEqual(found.map((f) => `${f.severity} ${where(f)}`), ["warning cloudflare/build-env-mismatch package.json:7"]);
  });

  it("reports --env with no CLOUDFLARE_ENV in the build, as a warning when vite.config stops that build", () => {
    const scripts = { "deploy:staging": "react-router build && wrangler deploy --env staging" };
    assert.deepEqual(app(scripts).map((f) => f.severity), ["error"]);
    assert.deepEqual(app(scripts, guarded()).map((f) => f.severity), ["warning"]);
  });

  it("still reports a build for one environment deployed as another, guard or not", () => {
    const found = app({ "deploy:production": "CLOUDFLARE_ENV=staging react-router build && wrangler deploy --env production" }, guarded());
    assert.deepEqual(found.map((f) => f.severity), ["error"]);
  });
});

describe("Cloudflare checks on cloudflare-good", () => {
  it("reports only what a dashboard or CLI has to show", () => {
    const findings = cloudflareFindings(fixture("cloudflare-good"));
    assert.deepEqual(findings.map(where).sort(), ["cloudflare/crons-before-cutover wrangler.jsonc:10", "cloudflare/hyperdrive-caching wrangler.jsonc:6", "cloudflare/r2-cors wrangler.jsonc:6"]);
    assert.ok(findings.every((f) => f.severity === "manual"));
  });

  it("reports wrangler types without --env from a script when every binding is in an environment", () => {
    const dir = tempDir("cloudflare-good");
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    pkg.scripts.typegen = "wrangler types && react-router typegen";
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
    const found = cloudflareFindings(dir).filter((f) => f.id.startsWith("cloudflare/types-"));
    assert.deepEqual(found.map(where).sort(), ["cloudflare/types-strict-vars vite.config.ts:7", "cloudflare/types-without-env package.json:10"]);
  });

  it("reads wrangler.toml too", () => {
    const dir = tempDir();
    write(dir, "package.json", "{}");
    write(dir, "wrangler.toml", ['name = "my-app"', 'main = "workers/app.ts"', "", "[[hyperdrive]]", 'binding = "HYPERDRIVE"', 'id = "abc"', "", "[env.staging]", 'name = "my-app-staging"'].join("\n"));
    const found = cloudflareFindings(dir).map(where).sort();
    assert.ok(found.includes("cloudflare/env-not-inherited wrangler.toml:8"), found.join("\n"));
    assert.ok(found.includes("cloudflare/no-placement wrangler.toml:4"), found.join("\n"));
  });

  it("asks for a check by hand when wrangler.jsonc can't be read", () => {
    const dir = tempDir();
    write(dir, "package.json", "{}");
    write(dir, "wrangler.jsonc", '{ "name": "my-app" "main": "x" }');
    const found = cloudflareFindings(dir);
    assert.equal(found.length, 1);
    assert.equal(found[0].id, "cloudflare/config-unreadable");
    assert.equal(found[0].severity, "manual");
  });
});

// the checks that assume Postgres through Hyperdrive, which a D1-only app never gets
const HYPERDRIVE_ONLY = ["cloudflare/no-placement", "cloudflare/hyperdrive-caching", "cloudflare/module-scope-client", "cloudflare/postgres-session-storage"];

describe("Cloudflare checks on cloudflare-d1-bad, an app on D1 only", () => {
  const findings = cloudflareFindings(fixture("cloudflare-d1-bad"));
  const expected: [string, "error" | "warning" | "manual", string, number][] = [
    // typegen runs wrangler types without --env, and the Prisma client has no D1 adapter
    ["cloudflare/types-without-env", "warning", "package.json", 9],
    ["cloudflare/prisma-client", "error", "app/prisma.server.ts", 1],
    // BEGIN TRANSACTION, then COMMIT, each through env.DB.prepare: one finding for the file
    ["cloudflare/d1-transaction", "error", "app/db.server.ts", 15],
    // set_config, = any(?), and a :: cast through env.DB, and an advisory lock through const db = env.DB
    ["cloudflare/d1-postgres-sql", "error", "app/db.server.ts", 5],
    ["cloudflare/d1-postgres-sql", "error", "app/db.server.ts", 6],
    ["cloudflare/d1-postgres-sql", "error", "app/db.server.ts", 10],
    ["cloudflare/d1-postgres-sql", "error", "app/jobs.server.ts", 6],
    // ilike and @> in a const passed to prepare()
    ["cloudflare/d1-postgres-sql", "error", "app/search.server.ts", 4],
    ["cloudflare/d1-postgres-sql", "error", "app/search.server.ts", 5],
    // bigserial and default now() in a migration; text[] and timestamptz, which SQLite accepts, aren't reported
    ["cloudflare/d1-postgres-sql", "error", "migrations/0001_init.sql", 3],
    ["cloudflare/d1-postgres-sql", "error", "migrations/0001_init.sql", 6],
    ["cloudflare/d1-columns", "error", "migrations/0002_shopify_order.sql", 2],
    ["cloudflare/d1-vector", "error", "migrations/0003_embeddings.sql", 3],
    ["cloudflare/d1-vector", "error", "prisma/schema.prisma", 14],
    ["cloudflare/d1-bound-parameters", "warning", "app/orders.server.ts", 2],
    ["cloudflare/d1-size", "manual", "wrangler.jsonc", 8],
  ];

  for (const [id, severity, file, line] of expected) {
    it(`reports ${id} at ${file}:${line}`, () => {
      const found = findings.find((f) => f.id === id && f.file === file && f.line === line);
      assert.ok(found, `missing ${id} at ${file}:${line}; got:\n${findings.map(where).join("\n")}`);
      assert.equal(found.severity, severity);
      assert.ok(found.fix.length > 0 && found.message.length > 0);
      assert.match(found.docs ?? "", /^https:\/\/docs\.gadget\.dev\/guides\/moving-to-another-platform\/cloudflare#/);
    });
  }

  it("reports nothing else, and none of the Hyperdrive checks", () => {
    assert.equal(findings.length, expected.length, findings.map(where).join("\n"));
    assert.deepEqual(findings.filter((f) => HYPERDRIVE_ONLY.includes(f.id)).map(where), []);
  });

  it("gives the error text local D1 returns", () => {
    const text = (file: string, line: number) => findings.find((f) => f.file === file && f.line === line)?.error;
    assert.equal(text("app/db.server.ts", 15), "To execute a transaction, please use the state.storage.transaction() or state.storage.transactionSync() APIs instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements.");
    assert.equal(text("app/db.server.ts", 5), "D1_ERROR: no such function: set_config");
    assert.equal(text("app/db.server.ts", 6), "D1_ERROR: no such function: any");
    assert.equal(text("app/db.server.ts", 10), 'D1_ERROR: unrecognized token: ":"');
    assert.equal(text("app/jobs.server.ts", 6), "D1_ERROR: no such function: pg_try_advisory_xact_lock");
    assert.equal(text("app/search.server.ts", 4), 'D1_ERROR: near "ilike": syntax error');
    assert.equal(text("app/search.server.ts", 5), 'D1_ERROR: unrecognized token: "@"');
    // wrangler d1 migrations apply prints D1's error without the D1_ERROR prefix
    assert.equal(text("migrations/0001_init.sql", 6), 'near "(": syntax error');
    assert.equal(text("migrations/0001_init.sql", 3), undefined);
    assert.match(findings.find((f) => f.file === "migrations/0001_init.sql" && f.line === 3)!.message, /\{ id: null \}/);
    assert.equal(text("migrations/0002_shopify_order.sql", 2), "too many columns on shopify_order: SQLITE_ERROR");
    assert.match(findings.find((f) => f.id === "cloudflare/d1-columns")!.message, /101 columns/);
    assert.equal(text("migrations/0003_embeddings.sql", 3), 'D1_ERROR: near ">": syntax error');
    assert.equal(text("app/orders.server.ts", 2), "D1_ERROR: too many SQL variables");
    assert.match(findings.find((f) => f.id === "cloudflare/d1-bound-parameters")!.message, /more than 33 rows/);
    assert.equal(text("package.json", 9), "error TS18048: 'env.DB' is possibly 'undefined'.");
  });

  it("points Prisma at the D1 adapter and keeps the D1 schema's sqlite provider", () => {
    assert.match(findings.find((f) => f.id === "cloudflare/prisma-client")!.fix, /@prisma\/adapter-d1/);
    // Prisma on D1 says provider = "sqlite", which common/prisma-sqlite reports for the template's leftover
    assert.ok(preflight(fixture("cloudflare-d1-bad"), []).findings.some((f) => f.id === "common/prisma-sqlite"));
    assert.ok(!preflight(fixture("cloudflare-d1-bad"), ["cloudflare"]).findings.some((f) => f.id === "common/prisma-sqlite"));
  });
});

describe("Cloudflare checks on cloudflare-d1-good", () => {
  it("reports only the D1 size reminder", () => {
    assert.deepEqual(cloudflareFindings(fixture("cloudflare-d1-good")).map((f) => `${f.severity} ${where(f)}`), ["manual cloudflare/d1-size wrangler.jsonc:8"]);
  });
});

describe("D1 checks", () => {
  // a D1-only app whose migrations folder is the default
  function d1App(files: Record<string, string>, wrangler = { name: "my-app", d1_databases: [{ binding: "DB", database_name: "my-app-db", database_id: "x" }] } as Record<string, unknown>) {
    const dir = tempDir();
    write(dir, "package.json", "{}");
    write(dir, "wrangler.jsonc", JSON.stringify(wrangler, null, 2));
    for (const [path, text] of Object.entries(files)) write(dir, path, text);
    return cloudflareFindings(dir);
  }

  it("scans the default migrations folder only when no Hyperdrive binding may own it", () => {
    const postgres = { "migrations/0001_init.sql": "create table widget (id bigserial primary key, created_at timestamptz default now());\n" };
    const both = { name: "my-app", hyperdrive: [{ binding: "HYPERDRIVE", id: "a" }], placement: { region: "aws:us-east-1" }, d1_databases: [{ binding: "CACHE", database_name: "my-app-cache", database_id: "x" }] };
    assert.deepEqual(d1App(postgres, both).filter((f) => f.id.startsWith("cloudflare/d1-postgres")).map(where), []);
    const named = { ...both, d1_databases: [{ ...both.d1_databases[0], migrations_dir: "migrations" }] };
    assert.equal(d1App(postgres, named).filter((f) => f.id === "cloudflare/d1-postgres-sql").length, 2);
    assert.equal(d1App(postgres).filter((f) => f.id === "cloudflare/d1-postgres-sql").length, 2);
  });

  it("counts a Prisma model's columns without its relation fields", () => {
    const fields = (n: number) => Array.from({ length: n }, (_, i) => `  field${i} String?`).join("\n");
    const schema = (n: number) => `datasource db {\n  provider = "sqlite"\n  url      = env("DATABASE_URL")\n}\n\nmodel Shop {\n  id String @id\n  orders ShopifyOrder[]\n}\n\nmodel ShopifyOrder {\n  id String @id\n  shopId String\n  shop Shop @relation(fields: [shopId], references: [id])\n${fields(n)}\n  @@map("shopify_order")\n}\n`;
    assert.deepEqual(d1App({ "prisma/schema.prisma": schema(98) }).filter((f) => f.id === "cloudflare/d1-columns").map(where), []);
    const found = d1App({ "prisma/schema.prisma": schema(99) }).filter((f) => f.id === "cloudflare/d1-columns");
    assert.deepEqual(found.map(where), ["cloudflare/d1-columns prisma/schema.prisma:11"]);
    assert.equal(found[0].error, "too many columns on shopify_order: SQLITE_ERROR");
  });

  it("reads exec() and a destructured binding, and ignores comments and other databases", () => {
    const code = [
      'import Database from "better-sqlite3";',
      "export async function run(env: Env) {",
      "  const { DB: db } = env;",
      '  new Database("local.db").prepare("BEGIN").run(); // another database: BEGIN TRANSACTION is fine there',
      '  await db.exec("insert into widget (id) values (1); COMMIT;");',
      "}",
    ].join("\n");
    const found = d1App({ "app/run.server.ts": code });
    assert.deepEqual(found.filter((f) => f.id === "cloudflare/d1-transaction").map(where), ["cloudflare/d1-transaction app/run.server.ts:5"]);
    assert.match(found.find((f) => f.id === "cloudflare/d1-transaction")!.message, /COMMIT through a D1 binding's exec\(\).*D1_EXEC_ERROR/);
  });

  it("reports a pgvector operator in a query sent to D1", () => {
    const found = d1App({ "app/similar.server.ts": 'export const similar = (db: D1Database, v: string) => db.prepare("select id from product_embedding order by embedding <=> ? limit 5").bind(v).all();\n' });
    assert.deepEqual(found.filter((f) => f.id === "cloudflare/d1-vector").map((f) => `${where(f)} ${f.error}`), ['cloudflare/d1-vector app/similar.server.ts:1 D1_ERROR: near ">": syntax error']);
  });

  it("accepts the reference's insertRows helper", () => {
    assert.deepEqual(d1App({ "app/d1.server.ts": block("cloudflare.md", "app/d1.server.ts") }).map(where), []);
  });
});

describe("the files in references/platforms/cloudflare.md", () => {
  it("pass the checks, leaving only what a dashboard or CLI has to show", () => {
    const dir = tempDir();
    for (const path of ["wrangler.jsonc", "workers/app.ts", "app/entry.server.tsx", "vite.config.ts", "app/services/files.server.ts"]) write(dir, path, block("cloudflare.md", path));
    // the commands the reference gives for building, deploying, and typing each environment
    write(dir, "package.json", JSON.stringify({
      scripts: {
        "deploy:staging": "CLOUDFLARE_ENV=staging react-router build && wrangler deploy",
        "deploy:production": "CLOUDFLARE_ENV=production react-router build && wrangler deploy",
        typegen: "wrangler types --env production --strict-vars=false && react-router typegen",
      },
      dependencies: { "@cloudflare/vite-plugin": "1.68.0", "@react-router/dev": "7.18.2", aws4fetch: "1.0.20", pg: "8.23.1", wrangler: "4.160.0" },
    }, null, 2));
    const findings = cloudflareFindings(dir);
    assert.deepEqual(findings.filter((f) => f.severity !== "manual").map(where), []);
    assert.deepEqual([...new Set(findings.map((f) => f.id))].sort(), ["cloudflare/crons-before-cutover", "cloudflare/hyperdrive-caching", "cloudflare/r2-cors"]);
  });
});
