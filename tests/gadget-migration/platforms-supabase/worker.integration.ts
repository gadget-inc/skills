// Runs the pgmq worker in references/platforms/supabase.md against Supabase's Postgres image:
// retries and archiving, a visibility timeout renewed during a long job, and the entry file's
// shutdown on SIGTERM.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { MIGRATIONS, dockerSkip, sql, startSupabasePostgres, stopSupabasePostgres, testDir, urlFor, writeBlocks } from "./helpers.ts";

const NAME = "migcheck-supabase-worker";
const PORT = 57442;
const skip = dockerSkip();
const dir = join(testDir, ".typecheck/run-worker");
const CALLS = join(dir, "calls.txt");
let admin: pg.Pool;
let server: pg.Pool;
let serverUrl: string;
let startWorker: any;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean> | boolean, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(100);
  }
}
const queueRows = async (table: string) => (await admin.query(`select msg_id, read_ct, message from pgmq.${table} order by msg_id`)).rows;

before(async () => {
  if (skip) return;
  const adminUrl = await startSupabasePostgres(NAME, PORT);
  admin = new pg.Pool({ connectionString: adminUrl, max: 4 });
  for (const path of MIGRATIONS) await admin.query(sql(path));
  await admin.query("alter role app_server with password 'worker'");
  serverUrl = urlFor(adminUrl, "app_server", "worker");
  server = new pg.Pool({ connectionString: serverUrl, max: 8 });
  writeBlocks(dir, ["app/queue/pgmq-worker.server.ts", "app/worker.server.ts"], {
    // stands in for the app's own code: records each call, fails or sleeps on request
    "app/services/external.server.ts": `import { appendFileSync } from "node:fs";
export async function notifyExternalSystem(orderId: string) {
  appendFileSync(process.env.CALLS_FILE!, orderId + "\\n");
  if (orderId.startsWith("slow")) await new Promise((resolve) => setTimeout(resolve, Number(process.env.SLOW_MS)));
  if (orderId.startsWith("fail")) throw new Error("refused " + orderId);
}
`,
  });
  ({ startWorker } = await import(pathToFileURL(join(dir, "app/queue/pgmq-worker.server.ts")).href));
});

after(async () => {
  await server?.end();
  await admin?.end();
  if (!skip) stopSupabasePostgres(NAME);
});

describe("supabase.md pgmq worker", () => {
  it("deletes a message that works, and archives one that fails after its seventh read", async (t) => {
    if (skip) return t.skip(skip);
    await admin.query("select pgmq.create('t_retries')");
    const calls: string[] = [];
    const worker = startWorker(server, "t_retries", async (m: { orderId: string }) => {
      calls.push(m.orderId);
      if (m.orderId === "bad") throw new Error("refused");
    }, { backoff: () => 0 });
    await admin.query(`select pgmq.send('t_retries', '{"orderId": "good"}'); select pgmq.send('t_retries', '{"orderId": "bad"}')`);
    await until(async () => (await queueRows("a_t_retries")).length === 1);
    await worker.stop();
    assert.deepEqual(calls.filter((c) => c === "good").length, 1);
    assert.deepEqual(calls.filter((c) => c === "bad").length, 7);
    assert.deepEqual(await queueRows("q_t_retries"), []);
    const archived = await queueRows("a_t_retries");
    assert.deepEqual(archived.map((r) => [r.read_ct, r.message.orderId]), [[7, "bad"]]);
  });

  it("waits the backoff between attempts", async (t) => {
    if (skip) return t.skip(skip);
    await admin.query("select pgmq.create('t_backoff')");
    const at: number[] = [];
    const worker = startWorker(server, "t_backoff", async () => {
      at.push(Date.now());
      throw new Error("refused");
    }, { maxAttempts: 3 });
    await admin.query(`select pgmq.send('t_backoff', '{"orderId": "bad"}')`);
    await until(async () => (await queueRows("a_t_backoff")).length === 1);
    await worker.stop();
    // 1 second after the first attempt, then 2 seconds after the second
    assert.equal(at.length, 3);
    assert.ok(at[1] - at[0] >= 900 && at[1] - at[0] < 2500, `first wait ${at[1] - at[0]} ms`);
    assert.ok(at[2] - at[1] >= 1900 && at[2] - at[1] < 3500, `second wait ${at[2] - at[1]} ms`);
  });

  it("keeps a job longer than its visibility timeout from running twice", async (t) => {
    if (skip) return t.skip(skip);
    // without renewal: a plain read with a 2-second timeout is read again while the job would still run
    await admin.query("select pgmq.create('t_plain'); select pgmq.send('t_plain', '{}')");
    await server.query("select * from pgmq.read('t_plain', 2, 1)");
    await sleep(2500);
    const again = await server.query("select read_ct from pgmq.read('t_plain', 2, 1)");
    assert.deepEqual(again.rows, [{ read_ct: 2 }]);

    // with the worker: a 2-second timeout renewed while a 7-second job runs, and two loops reading
    await admin.query("select pgmq.create('t_long')");
    const calls: number[] = [];
    const worker = startWorker(server, "t_long", async () => {
      calls.push(Date.now());
      await sleep(7000);
    }, { concurrency: 2, visibility: 2 });
    await admin.query(`select pgmq.send('t_long', '{"orderId": "slow"}')`);
    await until(async () => calls.length === 1 && (await queueRows("q_t_long")).length === 0);
    await worker.stop();
    assert.equal(calls.length, 1);
  });

  it("finishes the running job before stop() resolves", async (t) => {
    if (skip) return t.skip(skip);
    await admin.query("select pgmq.create('t_stop')");
    let finished = false;
    const worker = startWorker(server, "t_stop", async () => {
      await sleep(2000);
      finished = true;
    });
    await admin.query(`select pgmq.send('t_stop', '{}')`);
    await until(async () => (await queueRows("q_t_stop"))[0]?.read_ct === 1);
    await worker.stop();
    assert.equal(finished, true);
    assert.deepEqual(await queueRows("q_t_stop"), []);
  });

  it("drains the entry file's worker on SIGTERM and exits 0", async (t) => {
    if (skip) return t.skip(skip);
    writeFileSync(CALLS, "");
    const child = spawn(process.execPath, ["--import", pathToFileURL(join(testDir, "register.mjs")).href, join(dir, "app/worker.server.ts")], {
      env: { ...process.env, DATABASE_URL: serverUrl, CALLS_FILE: CALLS, SLOW_MS: "3000" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    await admin.query(`select pgmq.send('external', '{"orderId": "slow-1"}')`);
    await until(() => existsSync(CALLS) && readFileSync(CALLS, "utf8").includes("slow-1"));
    const signalled = Date.now();
    child.kill("SIGTERM");
    const code = await exited;
    assert.equal(code, 0, output);
    assert.match(output, /SIGTERM: reading no new messages, exiting after the running ones finish/);
    assert.ok(Date.now() - signalled >= 2000, "exited before the job finished");
    assert.deepEqual(await queueRows("q_external"), []);
    assert.deepEqual(await queueRows("a_external"), []);
  });
});
