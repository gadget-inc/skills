// Run with: npm test (from this folder). No account needed: the scripts in references/platforms/trigger-dev.md
// run against a local stand-in for Trigger.dev's API, which records what @trigger.dev/sdk 4.8.3 sends.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { typecheck, writeProject } from "../platform-blocks.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.TRIGGER_STANDIN_PORT ?? 57550);

// what the reference imports from files it doesn't show; queues.ts is the guide's
const services = {
  "app/trigger/queues.ts": 'import { queue } from "@trigger.dev/sdk";\nexport const externalQueue = queue({ name: "external", concurrencyLimit: 2 });\n',
  "app/services/external.server.ts": "export class OrderNotFoundError extends Error {}\nexport async function notifyExternalSystem(orderId: string): Promise<void> { void orderId; }\n",
  "app/services/audit-logs.server.ts": "export async function deleteAuditLogsOlderThan(days: number): Promise<number> { return days; }\n",
  "app/services/alerts.server.ts": "export async function reportFailedJob(job: string, id: string, message: string): Promise<void> { void job; void id; void message; }\n",
  "entry.ts": `export { enqueue } from "./app/services/jobs.server";
export { attachSchedules, detachSchedules } from "./scripts/attach-schedules";
export { missingTaskEnv } from "./scripts/check-trigger-env";
export { requeueScheduledJobs } from "./scripts/requeue-scheduled-jobs";
`,
};

describe("references/platforms/trigger-dev.md", () => {
  it("typechecks every TypeScript block with @trigger.dev/sdk and @trigger.dev/build 4.8.3", () => {
    const roots = writeProject("trigger-dev.md", join(here, ".typecheck/blocks"), services);
    typecheck(here, roots, { types: ["node"] });
  });

  it("reproduces the type error for a config without maxDuration", () => {
    const dir = join(here, ".typecheck/no-max-duration");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "trigger.config.ts"), 'import { defineConfig } from "@trigger.dev/sdk";\nexport default defineConfig({ project: "proj_abc123", dirs: ["./app/trigger"] });\n');
    assert.throws(() => typecheck(here, [dir], { types: ["node"] }), /Property 'maxDuration' is missing in type/);
  });
});

describe("references/platforms/trigger-dev.md against a stand-in API", () => {
  let server: Server;
  let mod: any;
  const triggers: { task: string; payload: any; options: any }[] = [];
  const keys = new Map<string, { id: string; until: number }>();
  const schedules = new Map<string, any>();
  let runs = 0;

  before(async () => {
    server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const url = new URL(req.url!, `http://127.0.0.1:${PORT}`);
      const send = (status: number, json: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(json));
      };
      assert.equal(req.headers.authorization, "Bearer tr_prod_standin");
      const trigger = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/trigger$/);
      if (trigger && req.method === "POST") {
        const { payload, options } = JSON.parse(body);
        const parsed = options.payloadType === "application/super+json" ? JSON.parse(payload).json : JSON.parse(payload);
        triggers.push({ task: decodeURIComponent(trigger[1]), payload: parsed, options });
        // the key lasts idempotencyKeyTTL from the trigger, as Trigger.dev's docs describe
        const key = options.idempotencyKey && `${trigger[1]}:${options.idempotencyKey}`;
        const held = key && keys.get(key);
        if (held && held.until > Date.now()) return send(200, { id: held.id, isCached: true }, { "x-trigger-jwt": "standin" });
        const id = `run_${++runs}`;
        if (key) keys.set(key, { id, until: Date.now() + Number(/^(\d+)d$/.exec(options.idempotencyKeyTTL ?? "30d")![1]) * 864e5 });
        return send(200, { id }, { "x-trigger-jwt": "standin" });
      }
      const schedule = (s: any) => ({ id: s.id, type: "IMPERATIVE", task: s.task, active: s.active, deduplicationKey: s.deduplicationKey, externalId: null, generator: { type: "CRON", expression: s.cron, description: "" }, timezone: s.timezone ?? "UTC", window: s.window, environments: [{ id: "env_prod", type: "PRODUCTION" }] });
      if (url.pathname === "/api/v1/schedules" && req.method === "POST") {
        const options = JSON.parse(body);
        const existing = schedules.get(options.deduplicationKey);
        const s = { ...options, id: existing?.id ?? `sched_${schedules.size + 1}`, active: true };
        schedules.set(options.deduplicationKey, s);
        return send(200, schedule(s));
      }
      if (url.pathname === "/api/v1/schedules" && req.method === "GET") {
        const data = [...schedules.values()].map(schedule);
        return send(200, { data, pagination: { currentPage: 1, totalPages: 1, count: data.length } });
      }
      const deactivate = url.pathname.match(/^\/api\/v1\/schedules\/([^/]+)\/deactivate$/);
      if (deactivate) {
        const s = [...schedules.values()].find((x) => x.id === deactivate[1]);
        s.active = false;
        return send(200, schedule(s));
      }
      if (url.pathname === "/api/v1/projects/proj_abc123/envvars/prod") return send(200, [{ name: "DATABASE_URL", value: "postgres://", isSecret: true }, { name: "SHOPIFY_API_SECRET", value: "x", isSecret: true }]);
      send(404, { error: `no route for ${req.method} ${url.pathname}` });
    });
    await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
    process.env.TRIGGER_API_URL = `http://127.0.0.1:${PORT}`;
    process.env.TRIGGER_SECRET_KEY = "tr_prod_standin";
    const dir = join(here, ".typecheck/standin");
    writeProject("trigger-dev.md", dir, services);
    await build({ entryPoints: [join(dir, "entry.ts")], bundle: true, platform: "node", format: "esm", packages: "external", outfile: join(dir, "bundle.mjs"), logLevel: "silent" });
    mod = await import(join(dir, "bundle.mjs"));
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  it("enqueue sends the store as concurrencyKey, a priority on every trigger, and a TTL that outlasts the delay", async () => {
    await mod.enqueue("notify-external-system", { shopId: "101", orderId: "1" }, { shopId: "101" });
    await mod.enqueue("notify-external-system", { shopId: "101", orderId: "2" }, { shopId: "101", priority: "high", id: "order-created-2" });
    const startAt = new Date(Date.now() + 7 * 864e5);
    await mod.enqueue("notify-external-system", { shopId: "101", orderId: "3" }, { shopId: "101", priority: "low", id: "remind-3", startAt });
    const [plain, high, later] = triggers.slice(-3);
    assert.equal(plain.task, "notify-external-system");
    assert.deepEqual(plain.payload, { shopId: "101", orderId: "1" });
    assert.equal(plain.options.concurrencyKey, "101");
    assert.equal(plain.options.priority, 300);
    assert.equal(plain.options.idempotencyKey, undefined);
    assert.equal(high.options.priority, 600);
    assert.equal(high.options.idempotencyKeyTTL, "2d"); // a day after the job, plus its 15 minutes, rounded up
    assert.equal(later.options.priority, 0);
    assert.equal(new Date(later.options.delay).getTime(), startAt.getTime());
    assert.equal(later.options.idempotencyKeyTTL, "9d"); // 7 days of delay, 15 minutes of run, 1 day after
  });

  it("requeues scheduled jobs once, however often the script runs", async () => {
    const jobs = [
      { id: "ba-1", action: "notifyExternalSystem", shopId: "808", params: { orderId: "808-1" }, startAt: new Date(Date.now() + 3 * 864e5).toISOString() },
      { id: "ba-2", action: "notifyExternalSystem", shopId: "808", params: { orderId: "808-2" }, startAt: new Date(Date.now() - 60_000).toISOString() },
    ];
    const first = await mod.requeueScheduledJobs(jobs);
    const second = await mod.requeueScheduledJobs(jobs);
    assert.deepEqual(second, first);
    const sent = triggers.filter((t) => t.payload.shopId === "808");
    assert.equal(sent[0].options.idempotencyKeyTTL, "5d");
    assert.ok(sent[0].options.delay);
    assert.equal(sent[1].options.delay, undefined); // a startAt already past runs now
    await assert.rejects(mod.requeueScheduledJobs([{ ...jobs[0], action: "other" }]), /no task for other/);
  });

  it("attaches each schedule once with no window, and detaches it for a rollback", async () => {
    await mod.attachSchedules();
    const [s] = await mod.attachSchedules();
    assert.equal(schedules.size, 1);
    assert.equal(s.task, "prune-audit-logs");
    assert.equal(s.generator.expression, "0 2 * * *");
    const stored = schedules.get("prune-audit-logs-prod");
    assert.deepEqual([stored.window, stored.timezone], ["0m", "UTC"]);
    assert.deepEqual(await mod.detachSchedules(), [s.id]);
    assert.equal(stored.active, false);
    assert.deepEqual(await mod.detachSchedules(), []);
  });

  it("lists the variables an environment is missing", async () => {
    assert.deepEqual(await mod.missingTaskEnv("proj_abc123", "prod", ["DATABASE_URL", "SHOPIFY_API_SECRET", "EXTERNAL_API_TOKEN"]), ["EXTERNAL_API_TOKEN"]);
  });
});
