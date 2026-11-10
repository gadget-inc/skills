import { Queue } from "bullmq";

const queue = new Queue("scheduled", { connection: { url: process.env.REDIS_URL } });
await queue.add("pruneAuditLogs", {});
await queue.close();
