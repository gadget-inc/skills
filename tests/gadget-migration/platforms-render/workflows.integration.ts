// The Workflows starter in references/platforms/render.md, against a stand-in for Render's task-runs API
// that rejects starts over its limit with a 429, as Render does. The test shortens the starter's one-minute
// windows to one second; everything else is the block as written. Needs Docker.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { block } from "../platform-blocks.ts";
import { connect, removeContainer, skipWithoutDocker, startValkey } from "./docker.ts";

const NAME = "migcheck-render-workflows";
const PORT = 57102;
const STORES = Array.from({ length: 12 }, (_, i) => `shop-${i + 1}`);
// the stand-in accepts this many starts a second, fewer than the shortened limiter lets through
const ACCEPTED_PER_SECOND = 5;

let server: Server;
let dir: string;
const started = new Map<string, string>(); // idempotency key -> run id
let rejected = 0;

before(async () => {
  if (skipWithoutDocker) return;
  startValkey(NAME, PORT);
  const window = { second: 0, count: 0 };
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.method !== "POST" || req.url !== "/v1/task-runs") return json(404, { id: "not-found", message: "not found" });
      const { task, input, idempotencyKey } = JSON.parse(body);
      assert.equal(task, "my-app-workflows/reconcileShop");
      const second = Math.floor(Date.now() / 1000);
      if (second !== window.second) Object.assign(window, { second, count: 0 });
      if (window.count >= ACCEPTED_PER_SECOND) {
        rejected++;
        return json(429, { id: "rate-limited", message: "too many task runs started" });
      }
      window.count++;
      if (!started.has(idempotencyKey)) started.set(idempotencyKey, `trn-${input[0]}`);
      json(201, { id: started.get(idempotencyKey) });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  process.env.RENDER_LOCAL_DEV_URL = `http://127.0.0.1:${address.port}`;

  // inside this folder, so the block's imports of bullmq and @renderinc/sdk resolve from its node_modules
  mkdirSync(fileURLToPath(new URL(".run", import.meta.url)), { recursive: true });
  dir = mkdtempSync(fileURLToPath(new URL(".run/workflows-", import.meta.url)));
  mkdirSync(join(dir, "app/jobs"), { recursive: true });
  writeFileSync(
    join(dir, "app/queues.server.ts"),
    `import IORedis from "ioredis";\nexport const connection = new IORedis({ port: ${PORT}, maxRetriesPerRequest: null });\n`
  );
  const code = block("render.md", "app/jobs/reconcile-all-shops.server.ts")
    .replace('from "../queues.server"', 'from "../queues.server.ts"')
    .replace("limiter: { max: 40, duration: 60_000 }", "limiter: { max: 8, duration: 1_000 }")
    .replace("worker.rateLimit(60_000)", "worker.rateLimit(1_000)");
  assert.match(code, /duration: 1_000/);
  assert.match(code, /rateLimit\(1_000\)/);
  writeFileSync(join(dir, "app/jobs/reconcile-all-shops.server.ts"), code);
});

after(async () => {
  server?.close();
  removeContainer(NAME);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("starting 12 stores' runs against a start limit", { skip: skipWithoutDocker }, () => {
  it("starts each store once, waits out every 429 without using an attempt, and adds nothing on a second cron run", async () => {
    const module = await import(join(dir, "app/jobs/reconcile-all-shops.server.ts"));
    const { connection } = await import(join(dir, "app/queues.server.ts"));
    const redis = await connect(PORT);
    await module.queueReconciliations(STORES, "2026-11-10");
    await module.queueReconciliations(STORES, "2026-11-10");
    assert.equal(await module.workflowStarts.count(), STORES.length);
    const worker = module.startWorkflowStartsWorker();
    try {

      for (let i = 0; i < 200 && (await module.workflowStarts.getCompletedCount()) < STORES.length; i++) await new Promise((r) => setTimeout(r, 100));

      assert.equal(await module.workflowStarts.getCompletedCount(), STORES.length);
      assert.equal(await module.workflowStarts.getFailedCount(), 0);
      assert.deepEqual([...started.keys()].sort(), STORES.map((s) => `reconcile-${s}-2026-11-10`).sort());
      assert.ok(rejected > 0, "the stand-in never returned a 429, so the rate-limit path didn't run");
      const jobs = await module.workflowStarts.getCompleted();
      // a RateLimitError puts the job back without counting an attempt
      assert.ok(jobs.every((job: { attemptsMade: number; returnvalue: string }) => job.attemptsMade <= 1 && job.returnvalue.startsWith("trn-shop-")));
    } finally {
      await worker.close();
      await module.workflowStarts.close();
      connection.disconnect();
      redis.disconnect();
    }
  });

  it("names each run's jobs by the most recent 02:00 UTC at or before now, not the clock's date", async () => {
    const module = await import(join(dir, "app/jobs/reconcile-all-shops.server.ts"));
    const { connection } = await import(join(dir, "app/queues.server.ts"));
    try {
      const cases: [string, string][] = [
        ["2026-11-10T02:00:00.000Z", "2026-11-10"], // on time
        ["2026-11-10T02:00:30.000Z", "2026-11-10"], // a few seconds late
        ["2026-11-10T23:59:59.999Z", "2026-11-10"], // a long retry, before midnight
        ["2026-11-11T00:05:00.000Z", "2026-11-10"], // after midnight: the clock's date would take the 11th's id
        ["2026-11-11T01:59:59.999Z", "2026-11-10"], // a minute before the next run is due
        ["2026-11-11T02:00:00.000Z", "2026-11-11"], // the next run
        ["2026-12-01T01:00:00.000Z", "2026-11-30"], // across a month
        ["2027-01-01T00:30:00.000Z", "2026-12-31"], // across a year
      ];
      for (const [now, day] of cases) assert.equal(module.scheduledDay(new Date(now)), day, now);
    } finally {
      await module.workflowStarts.close();
      connection.disconnect();
    }
  });
});
