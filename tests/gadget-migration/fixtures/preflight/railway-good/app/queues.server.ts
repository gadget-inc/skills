import { Queue } from "bullmq";
import IORedis from "ioredis";

export const connection = new IORedis(process.env.REDIS_URL!, { family: 0, maxRetriesPerRequest: null });
export const externalQueue = new Queue("external", { connection });
