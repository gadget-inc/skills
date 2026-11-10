// Run with: node --test "tests/**/*.test.ts"
// scripts/preflight.ts, its config readers and common checks, and the code in references/platforms/common.md.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { keyLine, parseDockerfile, parseJsonc, parseToml, parseYaml } from "../../skills/gadget/gadget-migration/scripts/checks/read-config.ts";
import { preflight } from "../../skills/gadget/gadget-migration/scripts/preflight.ts";
import { importBlock } from "./coverage-snippets.ts";
import { block } from "./platform-blocks.ts";

const script = fileURLToPath(new URL("../../skills/gadget/gadget-migration/scripts/preflight.ts", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/preflight/${name}`, import.meta.url));
const where = (findings: { id: string; file?: string; line?: number }[]) => findings.map((f) => `${f.id} ${f.file ?? ""}${f.line ? `:${f.line}` : ""}`.trim()).sort();

describe("config readers", () => {
  it("reads block YAML with line numbers", () => {
    const yaml = parseYaml(
      [
        "# a render.yaml-like file",
        "services:",
        "  - type: web # trailing comment",
        "    name: 'my-app-web'",
        "    envVars:",
        "      - key: DATABASE_URL",
        "        fromDatabase: { name: my-app-db, property: connectionString }",
        "    ipAllowList: []",
        "  - type: cron",
        '    schedule: "0 2 * * *"',
        "    script: |",
        "      echo one",
        "      # not a comment",
        "databases:",
        "- name: my-app-db",
        "  diskSizeGB: 100",
      ].join("\n")
    );
    assert.equal(yaml.services[0].name, "my-app-web");
    assert.deepEqual(yaml.services[0].envVars[0].fromDatabase, { name: "my-app-db", property: "connectionString" });
    assert.deepEqual(yaml.services[0].ipAllowList, []);
    assert.equal(yaml.services[1].schedule, "0 2 * * *");
    assert.equal(yaml.services[1].script, "echo one\n# not a comment\n");
    assert.equal(yaml.databases[0].diskSizeGB, 100);
    assert.equal(keyLine(yaml.services, 1), 9);
    assert.equal(keyLine(yaml.services[1], "schedule"), 10);
    assert.equal(keyLine(yaml.databases[0], "diskSizeGB"), 16);
  });

  it("reads TOML tables, arrays of tables, inline tables, and multi-line arrays", () => {
    const toml = parseToml(
      [
        'app = "my-app"',
        "kill_timeout = 300",
        "[http_service]",
        "  processes = [",
        '    "web", # comment',
        "  ]",
        '  concurrency = { type = "requests", soft_limit = 200 }',
        "  [[http_service.checks]]",
        '    path = "/healthz"',
        "[build.args]",
        '  VITE_SHOPIFY_API_KEY = "abc"',
        "[[vm]]",
        "  memory = '1gb'",
      ].join("\n")
    );
    assert.equal(toml.kill_timeout, 300);
    assert.deepEqual(toml.http_service.processes, ["web"]);
    assert.equal(toml.http_service.concurrency.soft_limit, 200);
    assert.equal(toml.http_service.checks[0].path, "/healthz");
    assert.equal(toml.build.args.VITE_SHOPIFY_API_KEY, "abc");
    assert.equal(toml.vm[0].memory, "1gb");
    assert.equal(keyLine(toml, "kill_timeout"), 2);
    assert.equal(keyLine(toml.http_service.checks[0], "path"), 9);
  });

  it("reads JSONC with comments, URLs in strings, and trailing commas", () => {
    const json = parseJsonc('{\n  // a comment\n  "routes": [{ "pattern": "https://app.example.com/*", },],\n  /* block */ "n": 1,\n}');
    assert.equal(json.routes[0].pattern, "https://app.example.com/*");
    assert.equal(json.n, 1);
  });

  it("joins Dockerfile continuation lines", () => {
    const steps = parseDockerfile('FROM node:22-alpine\nRUN apk add \\\n  openssl tzdata\nCMD ["npm", "run", "start"]\n');
    assert.deepEqual(
      steps.map((s) => [s.instruction, s.line]),
      [["FROM", 1], ["RUN", 2], ["CMD", 4]]
    );
    assert.match(steps[1].args, /openssl tzdata/);
  });
});

describe("common checks", () => {
  it("reports each pitfall in the bad app at its line", () => {
    const { findings } = preflight(fixture("common-bad"), []);
    assert.deepEqual(where(findings), [
      "common/app-url-slash app/urls.server.ts:1",
      "common/app-url-slash app/urls.server.ts:2",
      "common/bullmq-ioredis package.json",
      "common/cron-script-exit scripts/enqueue-prune-audit-logs.ts:3",
      "common/gadget-variable app/urls.server.ts:5",
      "common/host-without-scheme app/urls.server.ts:3",
      "common/load-direct-connection scripts/load-widgets.sql",
      "common/migrate-on-start Dockerfile:7",
      "common/redis-eviction",
      "common/rls-role db/policies.sql",
      "common/sqlite-migration prisma/migrations/20240530213853_create_session_table/migration.sql:4",
      "common/sqlite-migration-lock prisma/migrations/migration_lock.toml:2",
      "common/worker-sigterm app/worker.server.ts:5",
    ]);
    const datetime = findings.find((f) => f.id === "common/sqlite-migration")!;
    assert.equal(datetime.error, 'type "datetime" does not exist');
    assert.equal(datetime.severity, "error");
  });

  it("reports nothing but the Redis reminder for the fixed app", () => {
    const { findings } = preflight(fixture("common-good"), []);
    assert.deepEqual(where(findings), ["common/redis-eviction"]);
  });

  it("detects no platform for an app without platform files", () => {
    const { platforms } = preflight(fixture("common-good"));
    assert.deepEqual(
      platforms.map((p) => p.platform),
      ["common"]
    );
  });
});

describe("preflight.ts from the command line", () => {
  it("prints a report and exits 1 when it finds an error", () => {
    const run = spawnSync(process.execPath, [script, fixture("common-bad")], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /## Errors \(\d+\)/);
    assert.match(run.stdout, /You'll see: `type "datetime" does not exist`/);
    assert.match(run.stdout, /## Check by hand/);
  });

  it("prints JSON and exits 0 without errors", () => {
    const out = execFileSync(process.execPath, [script, fixture("common-good"), "--json"], { encoding: "utf8" });
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.platforms, ["common"]);
    assert.ok(parsed.findings.every((f: { severity: string }) => f.severity === "manual"));
  });

  it("rejects an unknown platform", () => {
    const run = spawnSync(process.execPath, [script, fixture("common-good"), "--platform", "heroku"], { encoding: "utf8" });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /unknown platform: heroku/);
  });
});

describe("common.md", () => {
  it("builds URLs the same with or without a trailing slash", async () => {
    const { appUrl } = await importBlock(block("common.md", "app/app-url.server.ts"));
    const saved = process.env.SHOPIFY_APP_URL;
    try {
      for (const origin of ["https://app.example.com", "https://app.example.com/"]) {
        process.env.SHOPIFY_APP_URL = origin;
        assert.equal(appUrl("api/callback"), "https://app.example.com/api/callback");
        assert.equal(appUrl("/api/callback"), "https://app.example.com/api/callback");
      }
      delete process.env.SHOPIFY_APP_URL;
      assert.throws(() => appUrl("api/callback"), /set SHOPIFY_APP_URL/);
    } finally {
      if (saved === undefined) delete process.env.SHOPIFY_APP_URL;
      else process.env.SHOPIFY_APP_URL = saved;
    }
  });

  it("bundles the worker with the build script the reference gives", () => {
    const pkg = JSON.parse(block("common.md", "package.json").replace(/^\/\/.*\n/, ""));
    assert.match(pkg.scripts["build:worker"], /--packages=external/);
    assert.match(pkg.scripts["build:worker"], /--outfile=build\/worker\.js/);
    assert.match(pkg.scripts.build, /npm run build:worker/);
  });
});
