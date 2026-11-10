// Railway's Redis template (redis:8.2 with the guide's start command, on a volume) holding BullMQ jobs:
// what a SIGKILL loses with snapshots only, what adding --appendonly yes in the wrong order loses, the way
// back, and the order in railway.md that keeps every job. Also checks that the railwayapp/redis:8.2 image
// the redis() helper deploys writes an append-only file already. Needs Docker with redis:8.2; the helper
// test also needs railwayapp/redis:8.2, which is linux/amd64 only.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { Queue } from "bullmq";
import { connect, docker, hasImage, removeContainer, removeVolume } from "./docker.ts";

const NAME = "migcheck-railway-redis";
const VOLUME = "migcheck-railway-redis-data";
const PORT = 57111;
const PASSWORD = "hush";
const skip = hasImage("redis:8.2") ? false : "needs Docker with the redis:8.2 image";

after(() => {
  removeContainer(NAME);
  removeContainer(`${NAME}-helper`);
  removeVolume(VOLUME);
});

// the template's start command from the guide, with or without --appendonly yes
function startRedis(appendOnly: boolean) {
  removeContainer(NAME);
  const command = `rm -rf $RAILWAY_VOLUME_MOUNT_PATH/lost+found/ && exec docker-entrypoint.sh redis-server --requirepass $REDIS_PASSWORD --save 60 1${appendOnly ? " --appendonly yes" : ""} --dir $RAILWAY_VOLUME_MOUNT_PATH`;
  docker("run", "-d", "--name", NAME, "-p", `127.0.0.1:${PORT}:6379`, "-v", `${VOLUME}:/data`, "-e", "RAILWAY_VOLUME_MOUNT_PATH=/data", "-e", `REDIS_PASSWORD=${PASSWORD}`, "redis:8.2", "/bin/sh", "-c", command);
}

// SIGTERM followed by SIGKILL with no time between, as a draining time of 0 does
function killAndRestart() {
  docker("kill", "--signal", "KILL", NAME);
  docker("start", NAME);
}

async function withQueue<T>(fn: (queue: Queue) => Promise<T>): Promise<T> {
  const connection = await connect(PORT, PASSWORD);
  const queue = new Queue("reconcile", { connection });
  try {
    return await fn(queue);
  } finally {
    await queue.close();
    connection.disconnect();
  }
}
const addJobs = (n: number) => withQueue((q) => q.addBulk(Array.from({ length: n }, (_, i) => ({ name: "reconcileShop", data: { shopId: String(i) } }))));
const waiting = () => withQueue((q) => q.getWaitingCount());
async function redisCommand<T>(fn: (redis: Awaited<ReturnType<typeof connect>>) => Promise<T>): Promise<T> {
  const redis = await connect(PORT, PASSWORD);
  try {
    return await fn(redis);
  } finally {
    redis.disconnect();
  }
}

describe("the Redis template with snapshots only", { skip }, () => {
  it("loses every job added since the last snapshot when killed", async () => {
    removeVolume(VOLUME);
    startRedis(false);
    await addJobs(1000);
    killAndRestart();
    assert.equal(await waiting(), 0);
  });
});

describe("adding --appendonly yes to the start command", { skip }, () => {
  it("before CONFIG SET, comes back empty; without the flag again, the snapshot is still there", async () => {
    removeContainer(NAME);
    removeVolume(VOLUME);
    startRedis(false);
    await addJobs(1000);
    await redisCommand((r) => r.save());
    assert.equal(await waiting(), 1000);

    startRedis(true);
    assert.equal(await waiting(), 0, "Redis loaded the new, empty append-only file instead of the snapshot");

    // the way back: remove the flag before anything writes and a snapshot replaces dump.rdb
    startRedis(false);
    assert.equal(await waiting(), 1000);
  });

  it("after CONFIG SET appendonly yes and a finished rewrite, keeps every job through two kills", async () => {
    removeContainer(NAME);
    removeVolume(VOLUME);
    startRedis(false);
    await addJobs(1000);
    await redisCommand(async (r) => {
      assert.equal(await r.config("SET", "appendonly", "yes"), "OK");
      for (let i = 0; i < 100; i++) {
        const info = await r.info("persistence");
        if (/aof_enabled:1/.test(info) && /aof_rewrite_in_progress:0/.test(info) && /aof_last_bgrewrite_status:ok/.test(info)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.fail("the append-only rewrite didn't finish");
    });

    docker("kill", "--signal", "KILL", NAME);
    startRedis(true);
    assert.equal(await waiting(), 1000);

    // with the file on, Redis writes each change within a second
    await addJobs(1000);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    killAndRestart();
    assert.equal(await waiting(), 2000);
  });
});

describe("the redis() helper's image", { skip: skip || (hasImage("railwayapp/redis:8.2") ? false : "needs the railwayapp/redis:8.2 image") }, () => {
  it("writes an append-only file and never evicts, with no start command change", async () => {
    const name = `${NAME}-helper`;
    removeContainer(name);
    docker("run", "-d", "--name", name, "--platform", "linux/amd64", "-e", `REDIS_PASSWORD=${PASSWORD}`, "railwayapp/redis:8.2");
    const config = async (key: string) => {
      for (let i = 0; i < 100; i++) {
        try {
          return docker("exec", name, "redis-cli", "-a", PASSWORD, "--no-auth-warning", "CONFIG", "GET", key).split("\n")[1];
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      throw new Error("the helper's Redis never answered");
    };
    assert.equal(await config("appendonly"), "yes");
    assert.equal(await config("maxmemory-policy"), "noeviction");
    // the image has no docker-entrypoint.sh, so the template's start command can't start it
    assert.throws(() => docker("run", "--rm", "--platform", "linux/amd64", "--entrypoint", "sh", "railwayapp/redis:8.2", "-c", "command -v docker-entrypoint.sh"));
  });
});
