// Run with: node --test "tests/**/*.test.ts"
// scripts/preflight.ts, its config readers and common checks, and the code in references/platforms/common.md.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { keyLine, parseDockerfile, parseJsonc, parseToml, parseYaml } from "../../skills/gadget/gadget-migration/scripts/checks/read-config.ts";
import { openRepo, preflight } from "../../skills/gadget/gadget-migration/scripts/preflight.ts";
import { dockerfileGeneratesPrisma, expandScripts, startOverrideFindings } from "../../skills/gadget/gadget-migration/scripts/checks/common.ts";
import { importBlock } from "./coverage-snippets.ts";
import { block } from "./platform-blocks.ts";

const script = fileURLToPath(new URL("../../skills/gadget/gadget-migration/scripts/preflight.ts", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/preflight/${name}`, import.meta.url));
const where = (findings: { id: string; file?: string; line?: number }[]) => findings.map((f) => `${f.id} ${f.file ?? ""}${f.line ? `:${f.line}` : ""}`.trim()).sort();

function withApp(files: Record<string, string>, test: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "common-preflight-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    test(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const prismaApp = (scripts: Record<string, string> = {}) => JSON.stringify({ scripts, dependencies: { "@prisma/client": "6.19.3", prisma: "6.19.3" } });

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
      "common/gadget-variable app/urls.server.ts:8",
      "common/host-without-scheme app/urls.server.ts:3",
      "common/host-without-scheme app/urls.server.ts:6",
      "common/host-without-scheme app/urls.server.ts:7",
      "common/load-direct-connection scripts/load-widgets.sql",
      "common/migrate-on-start Dockerfile:7",
      "common/redis-eviction",
      "common/rls-role db/policies.sql",
      "common/sqlite-migration prisma/migrations/20240530213853_create_session_table/migration.sql:4",
      "common/sqlite-migration-lock prisma/migrations/migration_lock.toml:2",
      "common/worker-sigterm app/worker.server.ts:5",
    ]);
    assert.equal(findings.find((f) => f.id === "common/worker-sigterm")!.severity, "error");
    assert.match(findings.find((f) => f.line === 8 && f.id === "common/gadget-variable")!.fix, /VITE_SUPPORT_EMAIL/);
    assert.equal(findings.find((f) => f.line === 7 && f.id === "common/host-without-scheme")!.error, "TypeError: Failed to parse URL");
    const datetime = findings.find((f) => f.id === "common/sqlite-migration")!;
    assert.equal(datetime.error, 'type "datetime" does not exist');
    assert.equal(datetime.severity, "error");
  });

  // app/urls.server.ts has a scheme or @ before each host-only variable, a log line, and a query string on
  // SHOPIFY_APP_URL; app/jobs/reconcile.server.ts returns its worker; app/workers/signals.server.ts handles
  // SIGTERM in a loop; scripts/export-model.ts reads GADGET_EXPORT_API_KEY, which Gadget doesn't set
  it("reports nothing but the Redis reminder for the fixed app", () => {
    const { findings } = preflight(fixture("common-good"), []);
    assert.deepEqual(where(findings), ["common/redis-eviction"]);
  });

  it("drops common/migrate-on-start when every service starts with its own command", () => {
    // both fixtures keep the template's CMD ["npm", "run", "docker-start"], which no service runs
    for (const platform of ["render", "railway"]) {
      const dir = fixture(`${platform}-good`);
      assert.match(readFileSync(join(dir, "Dockerfile"), "utf8"), /docker-start/);
      const ids = preflight(dir, [platform]).findings.map((f) => f.id);
      assert.ok(!ids.includes("common/migrate-on-start"), platform);
    }
    assert.ok(preflight(fixture("common-bad"), []).findings.some((f) => f.id === "common/migrate-on-start"));
  });

  it("detects no platform for an app without platform files", () => {
    const { platforms } = preflight(fixture("common-good"));
    assert.deepEqual(
      platforms.map((p) => p.platform),
      ["common"]
    );
  });
});

describe("common/worker-sigterm", () => {
  const factory = 'import { Worker } from "bullmq";\nexport function startWorker() {\n  return new Worker("q", async () => {}, {});\n}\n';
  const deps = JSON.stringify({ dependencies: { bullmq: "5.61.0" } });

  it("passes a factory whose importer closes the worker on SIGTERM, through ~/ or a relative path", () => {
    for (const specifier of ["~/jobs/q.server", "./jobs/q.server.js"]) {
      const entry = `import { startWorker } from "${specifier}";\nconst worker = startWorker();\nprocess.on("SIGTERM", async () => { await worker.close(); process.exit(0); });\n`;
      withApp({ "package.json": deps, "app/jobs/q.server.ts": factory, "app/worker.server.ts": entry }, (dir) => {
        assert.deepEqual(where(preflight(dir, []).findings.filter((f) => f.id === "common/worker-sigterm")), [], specifier);
      });
    }
  });

  it("warns about a factory whose importer never mentions SIGTERM", () => {
    const entry = 'import { startWorker } from "./jobs/q.server";\nstartWorker();\n';
    withApp({ "package.json": deps, "app/jobs/q.server.ts": factory, "app/worker.server.ts": entry }, (dir) => {
      const found = preflight(dir, []).findings.filter((f) => f.id === "common/worker-sigterm");
      assert.deepEqual(where(found), ["common/worker-sigterm app/jobs/q.server.ts:3"]);
      assert.equal(found[0].severity, "warning");
      assert.match(found[0].message, /app\/worker\.server\.ts/);
    });
  });
});

describe("prisma generate in the Dockerfile", () => {
  it("counts a prisma generate after the COPY that brings in the prisma folder, before COPY . .", () => {
    const dockerfile = "FROM node:22-alpine\nWORKDIR /app\nCOPY package.json package-lock.json* ./\nCOPY prisma ./prisma\nRUN npm ci --omit=dev && npx prisma generate\nCOPY . .\nRUN npm run build\nCMD [\"npm\", \"run\", \"start\"]\n";
    withApp({ "package.json": prismaApp(), Dockerfile: dockerfile, "prisma/schema.prisma": "" }, (dir) => {
      assert.equal(dockerfileGeneratesPrisma(openRepo(dir)), true);
    });
  });

  it("still reports a prisma generate that runs before the schema is copied in", () => {
    const dockerfile = "FROM node:22-alpine\nCOPY package.json ./\nRUN npm ci && npx prisma generate\nCOPY . .\nCMD [\"npm\", \"run\", \"start\"]\n";
    withApp({ "package.json": prismaApp(), Dockerfile: dockerfile, "prisma/schema.prisma": "" }, (dir) => {
      const repo = openRepo(dir);
      assert.equal(dockerfileGeneratesPrisma(repo), false);
      assert.deepEqual(where(startOverrideFindings(repo, "fly-io", "fly.toml", 3, "npm run start", "docs")), ["fly-io/prisma-generate fly.toml:3"]);
    });
  });

  it("reads the Dockerfile the platform names, not the root one", () => {
    const template = "FROM node:22-alpine\nCOPY . .\nRUN npm run build\nCMD [\"npm\", \"run\", \"docker-start\"]\n";
    const own = "FROM node:22-alpine\nCOPY . .\nRUN npx prisma generate\nCMD [\"npm\", \"run\", \"start\"]\n";
    withApp({ "package.json": prismaApp(), Dockerfile: template, "Dockerfile.fly": own }, (dir) => {
      const repo = openRepo(dir);
      assert.deepEqual(startOverrideFindings(repo, "fly-io", "fly.toml", 3, "npm run start", "docs", "Dockerfile.fly"), []);
      assert.match(startOverrideFindings(repo, "fly-io", "fly.toml", 3, "npm run start", "docs")[0].fix, /to Dockerfile after/);
    });
  });

  it("expands package-manager shorthand for scripts, and leaves their own commands alone", () => {
    withApp({ "package.json": prismaApp({ build: "prisma generate && react-router build", start: "react-router-serve", install: "echo" }) }, (dir) => {
      const repo = openRepo(dir);
      for (const command of ["pnpm build", "pnpm run build", "yarn build", "yarn run build", "npm run build", "npm run-script build"]) {
        assert.match(expandScripts(repo, command), /prisma generate/, command);
      }
      assert.match(expandScripts(repo, "npm start"), /react-router-serve/);
      for (const command of ["npm build", "npm ci", "pnpm install", "yarn install", "pnpm exec build"]) assert.equal(expandScripts(repo, command), command);
    });
  });
});

describe("preflight run outside the app's own directory", () => {
  const app = { "apps/web/package.json": JSON.stringify({ scripts: { start: "react-router-serve" } }), "apps/web/fly.toml": 'app = "my-app"\n' };

  it("asks for a run in the app's directory from a workspace root", () => {
    withApp({ "package.json": JSON.stringify({ private: true, workspaces: ["apps/*"] }), ...app }, (dir) => {
      const found = preflight(dir).findings.filter((f) => f.id === "common/app-directory");
      assert.equal(found.length, 1);
      assert.equal(found[0].severity, "manual");
      assert.match(found[0].message, /didn't check apps\/web/);
    });
    withApp({ "package.json": "{}", "pnpm-workspace.yaml": "packages:\n  - apps/*\n", ...app }, (dir) => {
      assert.match(preflight(dir).findings.find((f) => f.id === "common/app-directory")!.message, /pnpm-workspace\.yaml/);
    });
  });

  it("names the directory that has a --platform's files when the root doesn't", () => {
    withApp({ "package.json": JSON.stringify({ workspaces: ["apps/*"] }), ...app }, (dir) => {
      const { findings } = preflight(dir, ["fly-io"]);
      assert.deepEqual(findings.map((f) => f.id), ["common/app-directory"]);
      assert.match(findings[0].message, /--platform fly-io .* apps\/web does/);
      assert.match(findings[0].fix, /apps\/web.*--platform fly-io/);
    });
  });

  it("says nothing for Shopify's template, which lists its extensions as workspaces", () => {
    const root = JSON.stringify({ scripts: { start: "react-router-serve ./build/server/index.js" }, workspaces: { packages: ["extensions/*"] } });
    withApp({ "package.json": root, Dockerfile: "FROM node:22-alpine\n", "fly.toml": 'app = "my-app"\n', "extensions/thanks/package.json": "{}" }, (dir) => {
      assert.ok(!preflight(dir, ["fly-io"]).findings.some((f) => f.id === "common/app-directory"));
      // a --platform whose config the template doesn't have yet still gets the reminder
      assert.match(preflight(dir, ["render"]).findings.find((f) => f.id === "common/app-directory")!.message, /--platform render was given/);
    });
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
