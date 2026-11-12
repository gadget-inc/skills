import { Worker } from "bullmq";
import IORedis from "ioredis";

const connection = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
const worker = new Worker("external", async () => {}, { connection });
process.on("SIGTERM", async () => {
  await worker.close();
  process.exit(0);
});
