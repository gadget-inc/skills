// The TypeScript in references/platforms/railway.md: typechecked against railway 3.16.0 and the AWS SDK,
// and the project file evaluated for production and staging with the package's own functions. The IaC
// engine behind `railway config plan` ships in the Railway CLI and needs a linked project, so this is the
// offline check: it shows what the file asks Railway for, not what Railway does with it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { createRailwayContext, project, redis, service } from "railway/iac";
import { block, typecheck, writeProject } from "../platform-blocks.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const runs: string[] = [];
after(() => runs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// evaluates the file the way the CLI does: the default export called with the linked environment
async function evaluate(environment: string, flags: { scheduled?: boolean; pooled?: boolean } = {}) {
  mkdirSync(join(here, ".run"), { recursive: true });
  const dir = mkdtempSync(join(here, ".run/iac-"));
  runs.push(dir);
  const code = block("railway.md", ".railway/railway.ts")
    .replace("const SCHEDULED_WORK_MOVED = false;", `const SCHEDULED_WORK_MOVED = ${Boolean(flags.scheduled)};`)
    .replace("const POOLED = false;", `const POOLED = ${Boolean(flags.pooled)};`);
  writeFileSync(join(dir, "railway.ts"), code);
  const program = (await import(join(dir, "railway.ts"))).default;
  const definition = await program(createRailwayContext({ environment }), project);
  const byName = new Map<string, any>(definition.resources.map((r: any) => [r.name, r]));
  return { definition, byName };
}

describe("the TypeScript in railway.md", () => {
  it("typechecks with railway 3.16.0 and @aws-sdk/client-s3 3.1165.0", () => {
    const roots = writeProject("railway.md", join(here, ".typecheck"));
    // tsc's ** skips folders that start with a dot, so name .railway on its own
    typecheck(here, roots, {}, [".railway/*.ts", "**/*.ts", "**/*.tsx"]);
  });
});

describe("the project file in railway.md", () => {
  it("gives production 2 web replicas, its own domain on port 3000, and draining on both services", async () => {
    const { byName } = await evaluate("production");
    assert.deepEqual([...byName.keys()], ["postgres", "redis", "files", "web", "worker"]);
    const web = byName.get("web");
    assert.equal(web.deploy.startCommand, "npm run start");
    assert.deepEqual(web.deploy.preDeployCommand, ["npx prisma migrate deploy"]);
    assert.equal(web.deploy.healthcheckPath, "/healthz");
    assert.equal(web.deploy.drainingSeconds, 30);
    assert.equal(web.deploy.preDeployTimeoutSeconds, 1800);
    assert.deepEqual(web.deploy.multiRegionConfig, { "us-east4-eqdc4a": { numReplicas: 2 } });
    assert.deepEqual(web.networking.customDomains, { "app.example.com": { port: 3000 } });
    assert.deepEqual(web.variables.PORT, { type: "literal", value: "3000" });
    assert.deepEqual(web.variables.BUCKET, { type: "reference", resource: "bucket.files", output: "BUCKET" });
    const worker = byName.get("worker");
    assert.equal(worker.deploy.startCommand, "node build/worker.js");
    assert.equal(worker.deploy.drainingSeconds, 900);
    assert.equal(worker.variables.BUCKET, undefined);
  });

  it("gives staging 1 replica and its own domain, and names the environment in APP_ENV", async () => {
    const { byName } = await evaluate("staging");
    const web = byName.get("web");
    assert.deepEqual(web.deploy.multiRegionConfig, { "us-east4-eqdc4a": { numReplicas: 1 } });
    assert.deepEqual(web.networking.customDomains, { "staging.example.com": { port: 3000 } });
    assert.deepEqual(web.variables.APP_ENV, { type: "literal", value: "staging" });
    assert.deepEqual(web.variables.SHOPIFY_API_KEY, { type: "sharedReference", name: "SHOPIFY_API_KEY" });
    assert.deepEqual(web.variables.SHOPIFY_API_SECRET, { type: "preserve" });
  });

  it("adds the cron service only once scheduled work has moved", async () => {
    assert.equal((await evaluate("production")).byName.has("prune-audit-logs"), false);
    const cron = (await evaluate("production", { scheduled: true })).byName.get("prune-audit-logs");
    assert.equal(cron.deploy.cronSchedule, "0 2 * * *");
    assert.equal(cron.deploy.startCommand, "node build/enqueue-prune-audit-logs.js");
  });

  it("points migrations at the unpooled URL once pooling is on", async () => {
    const before = (await evaluate("production")).byName.get("worker").variables.DIRECT_DATABASE_URL;
    const pooled = (await evaluate("production", { pooled: true })).byName.get("worker").variables.DIRECT_DATABASE_URL;
    assert.deepEqual(before, { type: "reference", resource: "database.postgres", output: "DATABASE_URL" });
    assert.deepEqual(pooled, { type: "reference", resource: "database.postgres", output: "DATABASE_UNPOOLED_URL" });
  });
});

describe("railway 3.16.0's helpers", () => {
  it("deploy railwayapp/redis:8.2 from redis(), not the dashboard template's redis:8.2", () => {
    const node = redis("redis") as any;
    assert.equal(node.image, "railwayapp/redis:8.2");
    assert.equal(node.defaultMountPath, "/bitnami");
  });

  it("send a domain given as a string to port 8080", () => {
    const web = service("web", { domains: ["app.example.com"] }) as any;
    assert.deepEqual(web.networking.customDomains, { "app.example.com": { port: 8080 } });
  });
});
