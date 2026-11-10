import { Queue } from "bullmq";
import IORedis from "ioredis";

// ioredis 5.4.1 looks up IPv4 only by default, and Fly.io's private network is IPv6
export const connection = new IORedis(process.env.REDIS_URL!, { family: 6, maxRetriesPerRequest: null });

export const externalQueue = new Queue("external", { connection });
