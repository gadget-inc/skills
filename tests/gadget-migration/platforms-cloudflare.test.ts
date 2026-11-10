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
    // "deploy" builds with no environment, "deploy:production" builds staging
    ["cloudflare/build-env-mismatch", "error", "package.json", 7],
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
