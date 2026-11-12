// Run with: node --test "tests/**/*.test.ts"
// The Fly.io checks in scripts/checks/fly-io.ts, on the fixtures in fixtures/preflight/fly-io-*, and on the
// complete examples in references/platforms/fly-io.md, which must pass their own checks.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { preflight } from "../../skills/gadget/gadget-migration/scripts/preflight.ts";
import { block, platformBlocks } from "./platform-blocks.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/preflight/${name}`, import.meta.url));
const where = (findings: { id: string; file?: string; line?: number }[]) => findings.map((f) => `${f.id} ${f.file ?? ""}${f.line ? `:${f.line}` : ""}`.trim()).sort();
const own = (findings: { id: string }[]) => findings.filter((f) => f.id.startsWith("fly-io/"));

function app(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "fly-io-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe("Fly.io checks", () => {
  it("finds each pitfall in the bad fixture, at its line", () => {
    const { findings } = preflight(fixture("fly-io-bad"), ["fly-io"]);
    assert.deepEqual(where(own(findings)), [
      "fly-io/build-arg-unused fly.toml:11",
      "fly-io/build-time-variable fly.toml:8",
      "fly-io/cron-in-web fly.toml:16",
      "fly-io/cron-tz crontab:1",
      "fly-io/duplicate-app fly.toml:1",
      "fly-io/env-fly-prefix fly.toml:7",
      "fly-io/ioredis-family app/queues.server.ts:4",
      "fly-io/kill-signal fly.staging.toml:1",
      "fly-io/kill-signal fly.toml:1",
      "fly-io/kill-timeout fly.staging.toml:1",
      "fly-io/kill-timeout fly.toml:3",
      "fly-io/launch-rewrote-shopify-toml shopify.app.toml:3",
      "fly-io/migrate-on-start fly.toml:14",
      "fly-io/no-release-command fly.staging.toml:7",
      "fly-io/prisma-generate fly.staging.toml:8",
      "fly-io/prisma-generate fly.toml:15",
      "fly-io/supercronic-missing fly.toml:16",
      "fly-io/web-auto-stop fly.toml:22",
      "fly-io/web-shutdown app/queues.server.ts:4",
    ]);
    const severity = Object.fromEntries(own(findings).map((f) => [f.id, f.severity]));
    assert.equal(severity["fly-io/kill-signal"], "error");
    assert.equal(severity["fly-io/cron-tz"], "error");
    assert.equal(severity["fly-io/web-auto-stop"], "warning");
    assert.equal(severity["fly-io/launch-rewrote-shopify-toml"], "warning");
    // the script can't see REDIS_URL, which may end with ?family=6
    assert.equal(severity["fly-io/ioredis-family"], "warning");
    for (const f of own(findings)) {
      assert.ok(f.fix.endsWith("."), `${f.id} fix ends with a period`);
      assert.match(f.docs ?? "", /^https:\/\/docs\.gadget\.dev\/guides\/moving-to-another-platform\/fly-io#/);
    }
    const tz = own(findings).find((f) => f.id === "fly-io/cron-tz");
    assert.equal(tz?.error, "unknown time zone America/New_York");
    // min_machines_running is called out as not enough
    assert.match(own(findings).find((f) => f.id === "fly-io/web-auto-stop")!.message, /primary region only/);
  });

  it("drops common/migrate-on-start when every config's [processes] replace the Dockerfile's CMD", () => {
    const { findings } = preflight(fixture("fly-io-bad"), ["fly-io"]);
    assert.ok(!findings.some((f) => f.id === "common/migrate-on-start"));
    const dir = app({ "fly.toml": 'app = "my-app"\n', Dockerfile: 'FROM node:22-alpine\nCMD ["npm", "run", "docker-start"]\n', "package.json": JSON.stringify({ scripts: { "docker-start": "prisma migrate deploy && npm run start" } }) });
    try {
      assert.ok(preflight(dir, ["fly-io"]).findings.some((f) => f.id === "common/migrate-on-start"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // app/queues.server.ts sets family after an arrow function in the options, and in a URL
  it("finds nothing in the good fixture, which fixes each one", () => {
    assert.deepEqual(where(own(preflight(fixture("fly-io-good"), ["fly-io"]).findings)), []);
  });

  it("is detected from fly.toml", () => {
    assert.ok(preflight(fixture("fly-io-good")).platforms.some((p) => p.platform === "fly-io"));
  });

  it("reads kill_timeout as a duration string, and reports an unreadable fly.toml for checking by hand", () => {
    const dir = app({ "fly.toml": 'app = "my-app"\nkill_signal = "SIGTERM"\nkill_timeout = "10m"\n', "fly.staging.toml": 'app = "my-app-staging"\n[env\n' });
    try {
      const { findings } = preflight(dir, ["fly-io"]);
      assert.deepEqual(where(own(findings)), ["fly-io/kill-timeout fly.toml:3", "fly-io/unreadable-config fly.staging.toml"]);
      assert.equal(findings.find((f) => f.id === "fly-io/unreadable-config")?.severity, "manual");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the Dockerfile [build] dockerfile names, not the template's Dockerfile next to it", () => {
    const files: Record<string, string> = {};
    for (const b of platformBlocks("fly-io.md")) files[b.path] = b.code;
    // staging is a copy of fly.toml under another app name, as fly-io.md describes
    files["fly.staging.toml"] = files["fly.toml"].replace('app = "my-app"', 'app = "my-app-staging"');
    for (const config of ["fly.toml", "fly.staging.toml"]) files[config] = files[config].replace("[build.args]", '[build]\n  dockerfile = "Dockerfile.fly"\n[build.args]');
    files["Dockerfile.fly"] = files["Dockerfile"];
    // the template's own Dockerfile: no ARG, no Supercronic, no prisma generate
    files["Dockerfile"] = 'FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nRUN npm run build\nCMD ["npm", "run", "docker-start"]\n';
    files["package.json"] = JSON.stringify({ scripts: { start: "react-router-serve ./build/server/index.js" }, dependencies: { "@prisma/client": "6.19.3", prisma: "6.19.3" } });
    const dir = app(files);
    try {
      assert.deepEqual(where(own(preflight(dir, ["fly-io"]).findings)), []);
      // and a config without [build] dockerfile still reads the template's Dockerfile
      writeFileSync(join(dir, "fly.staging.toml"), files["fly.staging.toml"].replace('  dockerfile = "Dockerfile.fly"\n', ""));
      const found = own(preflight(dir, ["fly-io"]).findings);
      assert.deepEqual(where(found), ["fly-io/build-arg-unused fly.staging.toml:14", "fly-io/prisma-generate fly.staging.toml:30", "fly-io/supercronic-missing fly.staging.toml:34"]);
      assert.match(found.find((f) => f.id === "fly-io/build-arg-unused")!.message, /but Dockerfile has no ARG/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("follows pnpm build to the prisma generate in the build script", () => {
    const dir = app({
      "fly.toml": 'app = "my-app"\nkill_signal = "SIGTERM"\n[processes]\n  web = "pnpm start"\n[http_service]\n  processes = ["web"]\n  auto_stop_machines = "off"\n',
      Dockerfile: 'FROM node:22-alpine\nCOPY package.json pnpm-lock.yaml ./\nRUN corepack enable && pnpm install --frozen-lockfile\nCOPY . .\nRUN pnpm build\nCMD ["pnpm", "start"]\n',
      "package.json": JSON.stringify({ scripts: { build: "prisma generate && react-router build", start: "react-router-serve ./build/server/index.js" }, dependencies: { "@prisma/client": "6.19.3", prisma: "6.19.3" } }),
    });
    try {
      assert.deepEqual(where(own(preflight(dir, ["fly-io"]).findings)), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts a shutdown handler that registers SIGTERM in a loop", () => {
    const dir = app({
      "fly.toml": 'app = "my-app"\nkill_signal = "SIGTERM"\nkill_timeout = 300\n',
      "package.json": JSON.stringify({ dependencies: { bullmq: "5.61.0", ioredis: "5.8.2" } }),
      "app/queues.server.ts": 'import { Queue } from "bullmq";\nimport IORedis from "ioredis";\nexport const connection = new IORedis(process.env.REDIS_URL!);\nexport const queue = new Queue("q", { connection });\n',
      "app/entry.server.tsx": 'import { queue } from "./queues.server";\nfor (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, async () => { await queue.close(); });\n',
    });
    try {
      assert.deepEqual(where(own(preflight(dir, ["fly-io"]).findings)), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes the complete examples in fly-io.md, with common.md's worker and shutdown", () => {
    const files: Record<string, string> = {};
    for (const b of platformBlocks("fly-io.md")) files[b.path] = b.code;
    const { scripts } = JSON.parse(block("fly-io.md", "package.json").split("\n").slice(1).join("\n"));
    files["package.json"] = JSON.stringify({ scripts, dependencies: { "@prisma/client": "6.19.3", prisma: "6.19.3", bullmq: "6.7.3", ioredis: "6.0.0", esbuild: "0.28.2" } });
    files["app/queues.server.ts"] = block("common.md", "app/queues.server.ts");
    files["app/worker.server.ts"] = block("common.md", "app/worker.server.ts");
    files["app/entry.server.tsx"] = block("common.md", "app/entry.server.tsx");
    files["app/routes/app._index.tsx"] = "export default () => <p>{import.meta.env.VITE_APP_ENV}</p>;\n";
    files["prisma/migrations/1_init/migration.sql"] = 'CREATE TABLE "Session" ("id" TEXT PRIMARY KEY);\n';
    const dir = app(files);
    try {
      assert.deepEqual(where(own(preflight(dir, ["fly-io"]).findings)), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
