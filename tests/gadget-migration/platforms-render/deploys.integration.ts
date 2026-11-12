// What Render deploys do to BullMQ jobs, with short lock and stall timers so it runs in seconds:
// - a job whose worker is killed twice, as two deploys in a row do when it outlives maxShutdownDelaySeconds,
//   fails with "job stalled more than allowable limit" with most of its attempts left
// - a worker's concurrency option doubles while the old and new instances overlap, and
//   queue.setGlobalConcurrency holds, stored where `HGET bull:<queue>:meta concurrency` reads it
// Needs Docker.
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { Queue, Worker } from "bullmq";
import { connect, removeContainer, skipWithoutDocker, startValkey } from "./docker.ts";

const NAME = "migcheck-render-deploys";
const PORT = 57103;
const child = fileURLToPath(new URL(".run/hanging-worker.ts", import.meta.url));

before(() => {
  if (skipWithoutDocker) return;
  startValkey(NAME, PORT);
  mkdirSync(fileURLToPath(new URL(".run", import.meta.url)), { recursive: true });
  // a worker whose job never finishes, like a 12-minute action, stopped by SIGKILL as Render does after the delay
  writeFileSync(
    child,
    `import { Worker } from "bullmq";
import IORedis from "ioredis";
const connection = new IORedis({ port: ${PORT}, maxRetriesPerRequest: null });
new Worker("stalls", async () => { process.send!("active"); await new Promise(() => {}); }, { connection, lockDuration: 2000, stalledInterval: 1000 });
`
  );
});
after(() => removeContainer(NAME));

function startWorker(): { process: ChildProcess; active: Promise<void> } {
  const process = fork(child, { stdio: "ignore" });
  const active = new Promise<void>((resolve) => process.once("message", () => resolve()));
  return { process, active };
}

describe("a job longer than the shutdown delay", { skip: skipWithoutDocker }, () => {
  it("fails for good after two deploys, even with attempts left", async () => {
    const connection = await connect(PORT);
    const queue = new Queue("stalls", { connection });
    const job = await queue.add("reconcileShop", { shopId: "1" }, { attempts: 7, backoff: { type: "exponential", delay: 1000 } });
    const workers: ChildProcess[] = [];
    try {
      // first deploy: the old instance is killed mid-job, and the new one reruns it after the stall check
      for (let deploy = 1; deploy <= 2; deploy++) {
        const worker = startWorker();
        workers.push(worker.process);
        await worker.active;
        worker.process.kill("SIGKILL");
      }
      workers.push(startWorker().process);
      let state = "";
      for (let i = 0; i < 100 && state !== "failed"; i++) {
        await new Promise((r) => setTimeout(r, 200));
        state = await job.getState();
      }
      const failed = await queue.getJob(job.id!);
      assert.equal(state, "failed");
      assert.equal(failed!.failedReason, "job stalled more than allowable limit");
      assert.ok(failed!.attemptsMade < 7, `attemptsMade ${failed!.attemptsMade}`);
    } finally {
      for (const worker of workers) worker.kill("SIGKILL");
      await queue.close();
      connection.disconnect();
    }
  });
});

describe("two worker instances during a deploy overlap", { skip: skipWithoutDocker }, () => {
  async function peakConcurrency(queueName: string, global?: number) {
    const connection = await connect(PORT);
    const queue = new Queue(queueName, { connection });
    if (global) await queue.setGlobalConcurrency(global);
    let running = 0;
    let peak = 0;
    const work = async () => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 200));
      running--;
    };
    // the old and the new instance, each with concurrency 10
    const connections = [await connect(PORT), await connect(PORT)];
    const old = new Worker(queueName, work, { connection: connections[0], concurrency: 10 });
    const fresh = new Worker(queueName, work, { connection: connections[1], concurrency: 10 });
    await queue.addBulk(Array.from({ length: 60 }, (_, i) => ({ name: "notifyExternalSystem", data: { orderId: i } })));
    while ((await queue.getCompletedCount()) < 60) await new Promise((r) => setTimeout(r, 100));
    const stored = await connection.hget(`bull:${queueName}:meta`, "concurrency");
    await Promise.all([old.close(), fresh.close()]);
    await queue.close();
    for (const c of [connection, ...connections]) c.disconnect();
    return { peak, stored };
  }

  it("runs up to twice each worker's concurrency without a global limit", async () => {
    const { peak, stored } = await peakConcurrency("external-per-worker");
    assert.ok(peak > 10, `peak ${peak}`);
    assert.equal(stored, null);
  });

  it("holds setGlobalConcurrency(10) across both, and stores it in the queue's meta hash", async () => {
    const { peak, stored } = await peakConcurrency("external", 10);
    assert.ok(peak <= 10, `peak ${peak}`);
    assert.equal(stored, "10");
  });
});
