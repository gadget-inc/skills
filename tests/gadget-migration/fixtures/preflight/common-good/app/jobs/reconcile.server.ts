// a factory: whatever calls it starts the worker and closes it, so this file has no SIGTERM handler
import { Worker } from "bullmq";
import IORedis from "ioredis";

export function startReconcileWorker() {
  const connection = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  const worker: Worker = new Worker("reconcile", async () => {}, { connection, concurrency: 5 });
  return worker;
}
