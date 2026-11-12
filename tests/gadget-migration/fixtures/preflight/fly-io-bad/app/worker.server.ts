import { Worker } from "bullmq";
import { connection } from "./queues.server";
import { notifyExternalSystem } from "./services/external.server";

const worker = new Worker("external", async (job) => await notifyExternalSystem(job.data.orderId), { connection, concurrency: 10 });

process.on("SIGTERM", async () => {
  await worker.close();
  process.exit(0);
});
