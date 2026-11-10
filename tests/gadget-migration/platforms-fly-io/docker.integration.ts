// Builds the Dockerfile in fly-io.md, unchanged, around a small app with the reference's package.json
// scripts, crontab, and common.md's worker, then checks what the image gives each process group:
// Supercronic that accepts the crontab (with and without CRON_TZ), a generated Prisma client, and the
// bundled worker and enqueue script. A second build without tzdata reproduces "unknown time zone".
// Needs Docker and network access for npm and the Supercronic download; skips without Docker.
// Run with: npm test (from this folder)
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { block } from "../platform-blocks.ts";

const here = import.meta.dirname;
const skip = spawnSync("docker", ["info"], { encoding: "utf8" }).status === 0 ? false : "needs Docker";
const IMAGE = "migcheck-fly-io-image";
const NO_TZDATA = "migcheck-fly-io-image-no-tzdata";

function run(image: string, command: string) {
  return spawnSync("docker", ["run", "--rm", image, "sh", "-c", command], { encoding: "utf8" });
}

describe("fly-io.md's Dockerfile and crontab", { skip }, () => {
  const app = join(here, ".typecheck", "docker-app");

  before(() => {
    rmSync(app, { recursive: true, force: true });
    for (const dir of ["app/services", "scripts", "prisma"]) mkdirSync(join(app, dir), { recursive: true });
    const dockerfile = block("fly-io.md", "Dockerfile");
    writeFileSync(join(app, "Dockerfile"), dockerfile);
    writeFileSync(join(app, "crontab"), block("fly-io.md", "crontab"));
    // react-router build needs the whole template, so this app's build runs only the reference's build:worker
    const { scripts } = JSON.parse(block("fly-io.md", "package.json").split("\n").slice(1).join("\n"));
    assert.match(scripts.build, /^react-router build && npm run build:worker$/);
    writeFileSync(
      join(app, "package.json"),
      JSON.stringify({ name: "app", private: true, type: "module", scripts: { ...scripts, build: "npm run build:worker" }, dependencies: { "@prisma/client": "6.19.3", prisma: "6.19.3", bullmq: "6.7.3", ioredis: "6.0.0", esbuild: "0.28.2" } }, null, 2)
    );
    writeFileSync(join(app, "app/queues.server.ts"), block("common.md", "app/queues.server.ts"));
    writeFileSync(join(app, "app/worker.server.ts"), block("common.md", "app/worker.server.ts"));
    writeFileSync(join(app, "app/services/external.server.ts"), "export async function notifyExternalSystem(orderId: string) {\n  console.log(orderId);\n}\n");
    // the guide's enqueue script, shortened
    writeFileSync(
      join(app, "scripts/enqueue-prune-audit-logs.ts"),
      'import { Queue } from "bullmq";\nimport IORedis from "ioredis";\nconst connection = new IORedis(process.env.REDIS_URL!, { family: 6 });\nconst queue = new Queue("scheduled", { connection });\nawait queue.add("pruneAuditLogs", {}, { jobId: `pruneAuditLogs-${new Date().toISOString().slice(0, 10)}` });\nawait queue.close();\nconnection.disconnect();\n'
    );
    writeFileSync(join(app, "prisma/schema.prisma"), 'generator client {\n  provider = "prisma-client-js"\n}\n\ndatasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n\nmodel Session {\n  id String @id\n}\n');
    writeFileSync(join(app, ".dockerignore"), "node_modules\n");
    execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: app, stdio: "pipe" });
    execFileSync("docker", ["build", "-q", "--load", "-t", IMAGE, "--build-arg", "VITE_APP_ENV=staging", app], { stdio: "pipe", timeout: 600_000 });
    // the same Dockerfile with tzdata taken off the apk add line
    const without = dockerfile.replace("apk add --no-cache openssl tzdata", "apk add --no-cache openssl");
    assert.notEqual(without, dockerfile);
    writeFileSync(join(app, "Dockerfile.no-tzdata"), without);
    execFileSync("docker", ["build", "-q", "--load", "-t", NO_TZDATA, "-f", join(app, "Dockerfile.no-tzdata"), app], { stdio: "pipe", timeout: 600_000 });
  });

  after(() => {
    spawnSync("docker", ["rmi", "-f", IMAGE, NO_TZDATA]);
  });

  it("installs Supercronic, and the crontab passes supercronic -test", () => {
    const result = run(IMAGE, "supercronic -test /app/crontab");
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  it("accepts a CRON_TZ line, because the image has tzdata", () => {
    const result = run(IMAGE, "(echo CRON_TZ=America/New_York; cat /app/crontab) > /tmp/crontab && supercronic -test /tmp/crontab");
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  it("fails with unknown time zone without tzdata", () => {
    const result = run(NO_TZDATA, "(echo CRON_TZ=America/New_York; cat /app/crontab) > /tmp/crontab && supercronic -test /tmp/crontab");
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /unknown time zone America\/New_York/);
  });

  it("generates the Prisma client and bundles the worker and the enqueue script", () => {
    const result = run(IMAGE, "test -f node_modules/.prisma/client/index.js && test -f build/worker.js && test -f build/enqueue-prune-audit-logs.js && node --check build/worker.js && echo ok");
    assert.match(result.stdout, /ok/, result.stderr);
  });

  it("passes the build arg to the build through ARG", () => {
    // ARG values are visible to RUN steps after the ARG line, which is where npm run build reads them
    const history = execFileSync("docker", ["history", "--no-trunc", "--format", "{{.CreatedBy}}", IMAGE], { encoding: "utf8" });
    assert.match(history, /VITE_APP_ENV=staging/);
  });

  it("checks the amd64 Supercronic download, which Fly.io's builders take", () => {
    // only the Dockerfile's lines before EXPOSE, so the emulated build stays short
    const dir = join(app, "amd64");
    mkdirSync(dir, { recursive: true });
    const head = block("fly-io.md", "Dockerfile").split(/^EXPOSE/m)[0];
    writeFileSync(join(dir, "Dockerfile"), head);
    execFileSync("docker", ["build", "-q", "--load", "--platform", "linux/amd64", "-t", `${IMAGE}-amd64`, dir], { stdio: "pipe", timeout: 300_000 });
    try {
      const result = spawnSync("docker", ["run", "--rm", "--platform", "linux/amd64", `${IMAGE}-amd64`, "sh", "-c", "uname -m && supercronic -version"], { encoding: "utf8" });
      assert.match(result.stdout + result.stderr, /x86_64[\s\S]*v0\.2\.51/);
    } finally {
      spawnSync("docker", ["rmi", "-f", `${IMAGE}-amd64`]);
    }
  });
});
