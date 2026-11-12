import { Render } from "@renderinc/sdk";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";

const connection = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
const render = new Render();
export const workflowStarts = new Queue("workflow-starts", { connection });

// one queued job per store, started at most 40 a minute, under Hobby's 50
export const startWorker = new Worker(
  "workflow-starts",
  async (job) => {
    await render.workflows.startTask("my-app-workflows/reconcileShop", [job.data.shopId], { idempotencyKey: `reconcile-${job.data.shopId}-${job.data.day}` });
  },
  { connection, limiter: { max: 40, duration: 60_000 } }
);

process.on("SIGTERM", async () => {
  await startWorker.close();
  process.exit(0);
});
