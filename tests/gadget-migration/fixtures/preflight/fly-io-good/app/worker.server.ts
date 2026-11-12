import { Worker } from "bullmq";
import { connection } from "./queues.server";
import { notifyExternalSystem } from "./services/external.server";

const worker = new Worker("external", async (job) => await notifyExternalSystem(job.data.orderId), { connection, concurrency: 10 });

async function shutdown() {
  await worker.close();
  await connection.quit();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
