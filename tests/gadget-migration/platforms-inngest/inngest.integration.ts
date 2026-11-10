// Run with: npm test (from this folder). The Dev Server tests need INNGEST_CLI, the path to an inngest-cli
// 1.51.0 binary, such as the one `npm install inngest-cli@1.51.0` puts in node_modules/.bin, and skip without it.
// They run the code blocks in references/platforms/inngest.md, bundled with esbuild, against that Dev Server.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { typecheck, writeProject } from "../platform-blocks.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const CLI = process.env.INNGEST_CLI;
const DEV_PORT = Number(process.env.INNGEST_DEV_PORT ?? 57530);
const APP_PORT = Number(process.env.INNGEST_APP_PORT ?? 57540);
const DEV = `http://127.0.0.1:${DEV_PORT}`;

// What the reference's functions call. They record each call so the tests can see when steps ran.
const services = {
  "app/services/record.ts": `export const calls: { kind: string; id: string; at: number; detail?: unknown }[] = [];
export const record = (kind: string, id: string, detail?: unknown) => calls.push({ kind, id, at: Date.now(), detail });
`,
  "app/services/external.server.ts": `import { record } from "./record";
export class OrderNotFoundError extends Error {}
export async function notifyExternalSystem(orderId: string): Promise<void> {
  record("notify-start", orderId);
  if (orderId.startsWith("missing")) throw new OrderNotFoundError(\`order \${orderId} no longer exists\`);
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.NOTIFY_MS ?? 1500)));
  record("notify-end", orderId);
}
`,
  "app/services/audit-logs.server.ts": `import { record } from "./record";
export async function deleteAuditLogsOlderThan(days: number): Promise<number> {
  record("prune-start", String(days));
  await new Promise((resolve) => setTimeout(resolve, 2000));
  record("prune-end", String(days));
  return 0;
}
`,
  "app/services/alerts.server.ts": `import { record } from "./record";
export async function reportFailedJob(job: string, id: string, message: string): Promise<void> {
  record("failed", id, { job, message });
}
`,
  "entry.ts": `export { functions, inngest } from "./app/inngest.server";
export { enqueue, toEventData } from "./app/services/jobs.server";
export { requeueScheduledJobs } from "./scripts/requeue-scheduled-jobs";
export { calls } from "./app/services/record";
`,
};

describe("references/platforms/inngest.md", () => {
  it("typechecks every TypeScript block with inngest 4.26.2", () => {
    const roots = writeProject("inngest.md", join(here, ".typecheck/blocks"), services);
    typecheck(here, roots, { types: ["node"] });
  });

  it("reproduces the ECONNREFUSED failure signature, which needs no Dev Server", () => {
    const script = `
      import { Inngest } from "inngest";
      const out = {};
      process.env.INNGEST_DEV = "1";
      try { await new Inngest({ id: "my-app" }).send({ name: "a/b", data: {} }); } catch (e) { out.devFlag = e.message + " " + e.cause?.errors?.map((x) => x.message).join("; "); }
      console.log(JSON.stringify(out));
    `;
    const env = { ...process.env };
    for (const key of ["INNGEST_DEV", "INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY", "INNGEST_BASE_URL"]) delete env[key];
    const out = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: here, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    assert.match(out.devFlag, /^fetch failed .*connect ECONNREFUSED 127\.0\.0\.1:8288/);
  });
});

describe("references/platforms/inngest.md against the Inngest Dev Server", { skip: !CLI && "set INNGEST_CLI to an inngest-cli 1.51.0 binary" }, () => {
  let dev: ChildProcess;
  let server: Server;
  // the functions the app serves; swapped by the cron test
  let current: any;
  let handler: (args: { request: Request }) => Promise<Response>;
  let bundleOff: any;
  let bundleOn: any;

  const gql = async (query: string) => (await (await fetch(`${DEV}/v0/gql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) })).json()) as any;
  const slugs = async () => ((await gql("{ apps { functions { slug } } }")).data?.apps ?? []).flatMap((a: any) => a.functions.map((f: any) => f.slug)).sort();
  const waitFor = async <T>(check: () => T | Promise<T>, timeout: number, what: string): Promise<T> => {
    const end = Date.now() + timeout;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };

  async function bundle(name: string, edit?: (source: string) => string) {
    const dir = join(here, ".typecheck", name);
    writeProject("inngest.md", dir, services);
    if (edit) writeFileSync(join(dir, "app/inngest.server.ts"), edit(readFileSync(join(dir, "app/inngest.server.ts"), "utf8")));
    const outfile = join(dir, "bundle.mjs");
    await build({ entryPoints: [join(dir, "entry.ts")], bundle: true, platform: "node", format: "esm", packages: "external", outfile, logLevel: "silent" });
    return import(outfile);
  }

  before(async () => {
    process.env.INNGEST_DEV = DEV;
    delete process.env.INNGEST_SCHEDULES;
    bundleOff = await bundle("devserver-off");
    process.env.INNGEST_SCHEDULES = "on";
    // the same file with the nightly schedule run every minute, so the test sees it fire
    bundleOn = await bundle("devserver-on", (source) => source.replace('cron: "0 2 * * *"', 'cron: "* * * * *"'));
    delete process.env.INNGEST_SCHEDULES;
    const { serve } = await import("inngest/remix");
    const use = (b: any) => {
      current = b;
      handler = serve({ client: b.inngest, functions: b.functions }) as any;
    };
    use(bundleOff);
    (globalThis as any).useBundle = use;
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const request = new Request(`http://127.0.0.1:${APP_PORT}${req.url}`, { method: req.method, headers: req.headers as any, body: ["GET", "HEAD"].includes(req.method!) ? undefined : Buffer.concat(chunks) });
      const response = await handler({ request });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>((resolve) => server.listen(APP_PORT, "127.0.0.1", resolve));
    dev = spawn(CLI!, ["dev", "--no-discovery", "-u", `http://127.0.0.1:${APP_PORT}/api/inngest`, "-p", String(DEV_PORT), "--connect-gateway-port", String(DEV_PORT + 1), "--connect-executor-grpc-port", String(DEV_PORT + 2), "--connect-gateway-grpc-port", String(DEV_PORT + 3), "--poll-interval", "1"], { stdio: "ignore" });
    await waitFor(async () => (await slugs().catch(() => [])).length > 0, 30_000, "the Dev Server to sync the app");
  });

  after(async () => {
    dev?.kill();
    await new Promise((resolve) => server?.close(resolve));
  });

  it("serves the cron function only with INNGEST_SCHEDULES=on", async () => {
    assert.deepEqual(await slugs(), ["my-app-notify-external-system", "my-app-notify-external-system-failure", "my-app-notify-external-system-of-update", "my-app-prune-audit-logs"]);
    assert.equal(bundleOn.functions.length, 4);
  });

  it("shares one limit of 2 per store across both functions, and other stores don't wait", async () => {
    const { enqueue, calls } = current;
    const sends = [];
    for (let n = 1; n <= 4; n++) sends.push(enqueue("app/order.created", 101n, { orderId: `101-c${n}` }), enqueue("app/order.updated", 101n, { orderId: `101-u${n}` }));
    for (let n = 1; n <= 2; n++) sends.push(enqueue("app/order.created", 202n, { orderId: `202-c${n}` }));
    await Promise.all(sends);
    await waitFor(() => calls.filter((c: any) => c.kind === "notify-end" && /^(101|202)-/.test(c.id)).length === 10, 60_000, "10 jobs");
    const running = (shop: string) => {
      const marks = calls.filter((c: any) => c.id.startsWith(`${shop}-`) && c.kind.startsWith("notify")).map((c: any) => ({ at: c.at, d: c.kind === "notify-start" ? 1 : -1 }));
      marks.sort((a: any, b: any) => a.at - b.at || a.d - b.d);
      let now = 0;
      let max = 0;
      for (const m of marks) max = Math.max(max, (now += m.d));
      return max;
    };
    assert.equal(running("101"), 2);
    const lastOf101 = Math.max(...calls.filter((c: any) => c.kind === "notify-end" && c.id.startsWith("101-")).map((c: any) => c.at));
    const firstOf202 = Math.min(...calls.filter((c: any) => c.kind === "notify-start" && c.id.startsWith("202-")).map((c: any) => c.at));
    assert.ok(firstOf202 < lastOf101 - 3000, "the second store ran while the first still had a backlog");
  });

  it("starts a high job ahead of default jobs already waiting", async () => {
    const { enqueue, calls } = current;
    for (let n = 1; n <= 5; n++) await enqueue("app/order.created", 303n, { orderId: `303-d${n}` });
    await waitFor(() => calls.filter((c: any) => c.kind === "notify-start" && c.id.startsWith("303-")).length === 2, 20_000, "the first 2 jobs");
    await enqueue("app/order.created", 303n, { orderId: "303-high" }, { priority: "high" });
    await waitFor(() => calls.filter((c: any) => c.kind === "notify-end" && c.id.startsWith("303-")).length === 6, 60_000, "6 jobs");
    const order = calls.filter((c: any) => c.kind === "notify-start" && c.id.startsWith("303-")).map((c: any) => c.id);
    assert.equal(order.indexOf("303-high"), 2, `start order: ${order.join(", ")}`);
  });

  it("maps startAt to ts, sends bigints as strings, and drops a duplicate id", async () => {
    const { enqueue, calls } = current;
    const sent = Date.now();
    await enqueue("app/order.created", 404n, { orderId: "404-later" }, { startAt: new Date(sent + 6000) });
    await enqueue("app/order.created", 505n, { orderId: 5051n });
    await enqueue("app/order.created", 606n, { orderId: "606-dup" }, { id: "order-created-606-dup" });
    await enqueue("app/order.created", 606n, { orderId: "606-dup" }, { id: "order-created-606-dup" });
    const later = await waitFor(() => calls.find((c: any) => c.kind === "notify-start" && c.id === "404-later"), 30_000, "the delayed job");
    // the Dev Server started it within a second of ts, sometimes a little early (5,318 ms for a 6,000 ms delay)
    assert.ok(later.at - sent >= 4500, `started ${later.at - sent} ms after sending`);
    assert.ok(calls.some((c: any) => c.kind === "notify-start" && c.id === "5051"));
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal(calls.filter((c: any) => c.kind === "notify-start" && c.id === "606-dup").length, 1);
  });

  it("stops retrying on NonRetriableError and runs onFailure once", async () => {
    const { enqueue, calls } = current;
    await enqueue("app/order.created", 707n, { orderId: "missing-707" });
    const failed = await waitFor(() => calls.find((c: any) => c.kind === "failed" && c.id === "missing-707"), 30_000, "onFailure");
    assert.equal((failed.detail as any).message, "order missing-707 no longer exists");
    assert.equal(calls.filter((c: any) => c.kind === "notify-start" && c.id === "missing-707").length, 1);
  });

  it("re-creates scheduled jobs once, even when the script runs twice", async () => {
    const { requeueScheduledJobs, calls } = current;
    const now = Date.now();
    const jobs = [
      { id: "ba-1", action: "notifyExternalSystem", shopId: "808", params: { orderId: "808-future" }, startAt: new Date(now + 5000).toISOString() },
      { id: "ba-2", action: "notifyExternalSystem", shopId: "808", params: { orderId: "808-past" }, startAt: new Date(now - 60_000).toISOString() },
    ];
    assert.deepEqual(await requeueScheduledJobs(jobs), ["ba-1", "ba-2"]);
    await requeueScheduledJobs(jobs);
    await waitFor(() => calls.filter((c: any) => c.kind === "notify-end" && c.id.startsWith("808-")).length === 2, 30_000, "both jobs");
    const future = calls.find((c: any) => c.kind === "notify-start" && c.id === "808-future");
    const past = calls.find((c: any) => c.kind === "notify-start" && c.id === "808-past");
    // the Dev Server starts a run with a ts up to about a second early, as inngest.md says
    assert.ok(future.at - now >= 3500, `the future job started ${future.at - now} ms after it was sent`);
    assert.ok(past.at < future.at - 1500, "the job whose startAt had passed ran first");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.equal(calls.filter((c: any) => c.kind === "notify-start" && c.id.startsWith("808-")).length, 2);
    await assert.rejects(requeueScheduledJobs([{ ...jobs[0], action: "somethingElse" }]), /no event for somethingElse/);
  });

  it("skips a second prune while one is running", async () => {
    const { inngest, calls } = current;
    await inngest.send([1, 2].map((n) => ({ name: "app/audit-logs.prune", id: `manual-prune-${n}`, data: { olderThanDays: 30 } })));
    await waitFor(() => calls.some((c: any) => c.kind === "prune-end" && c.id === "30"), 30_000, "the prune");
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal(calls.filter((c: any) => c.kind === "prune-start" && c.id === "30").length, 1);
  });

  it("runs the schedule once INNGEST_SCHEDULES=on is synced, and hands the work to the event function", { timeout: 120_000 }, async () => {
    (globalThis as any).useBundle(bundleOn);
    await waitFor(async () => (await slugs()).includes("my-app-prune-audit-logs-schedule"), 30_000, "the schedule to sync");
    const prune = await waitFor(() => bundleOn.calls.find((c: any) => c.kind === "prune-end" && c.id === "90"), 90_000, "the scheduled prune");
    assert.ok(prune);
  });
});
