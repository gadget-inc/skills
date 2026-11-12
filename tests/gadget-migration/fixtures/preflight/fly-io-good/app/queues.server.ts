import { Queue } from "bullmq";
import IORedis from "ioredis";

// ioredis 5.4.1 looks up IPv4 only by default, and Fly.io's private network is IPv6
export const connection = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
  retryStrategy: (times) => Math.min(times * 200, 2000),
  family: 6,
});
// family in the URL instead of the options
export const cache = new IORedis(`${process.env.CACHE_URL}?family=6`);

export const externalQueue = new Queue("external", { connection });
