// Render Key Value's default eviction policy, allkeys-lru, against noeviction, with BullMQ on Valkey 8.
// Backs render/keyvalue-eviction and the first row of render.md's failure signatures. Needs Docker.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { Queue } from "bullmq";
import type IORedis from "ioredis";
import { connect, removeContainer, skipWithoutDocker, startValkey } from "./docker.ts";

const NAME = "migcheck-render-keyvalue";
const PORT = 57101;
const JOBS = 4000;
const payload = { body: "x".repeat(2000) }; // 2KB jobs, as in the guide

after(() => removeContainer(NAME));

async function fill(queue: Queue, connection: IORedis) {
  let accepted = 0;
  let firstError: string | undefined;
  for (let i = 0; i < JOBS; i++) {
    try {
      await queue.add("notifyExternalSystem", { ...payload, orderId: i });
      accepted++;
    } catch (error) {
      firstError ??= (error as Error).message;
    }
  }
  // count the jobs whose data is still there: eviction deletes job hashes, and the wait list can keep their ids
  const left = (await connection.keys("bull:external:[0-9]*")).length;
  return { accepted, firstError, left };
}

describe("a 4MB Key Value as a BullMQ queue", { skip: skipWithoutDocker }, () => {
  it("with allkeys-lru, accepts every job, keeps a fraction, and only warns", async () => {
    startValkey(NAME, PORT, "--maxmemory", "4mb", "--maxmemory-policy", "allkeys-lru");
    const connection = await connect(PORT);
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
    const queue = new Queue("external", { connection });
    try {
      const { accepted, firstError, left } = await fill(queue, connection);
      assert.equal(accepted, JOBS);
      assert.equal(firstError, undefined);
      // about 1,100 of 4,000 kept their data in runs on valkey/valkey:8 (8.1)
      assert.ok(left < JOBS / 2, `${left} of ${JOBS} jobs left`);
      assert.ok(warnings.some((w) => w.includes('IMPORTANT! Eviction policy is allkeys-lru. It should be "noeviction"')), warnings.join("\n"));
    } finally {
      console.warn = warn;
      await queue.close();
      connection.disconnect();
    }
  });

  it("with noeviction, fails adds once full and keeps every job it accepted", async () => {
    startValkey(NAME, PORT, "--maxmemory", "4mb", "--maxmemory-policy", "noeviction");
    const connection = await connect(PORT);
    const queue = new Queue("external", { connection });
    try {
      const { accepted, firstError, left } = await fill(queue, connection);
      assert.ok(accepted < JOBS, `${accepted} accepted`);
      assert.match(firstError ?? "", /OOM command not allowed when used memory > 'maxmemory'/);
      assert.equal(left, accepted);
    } finally {
      await queue.close();
      connection.disconnect();
    }
  });
});
