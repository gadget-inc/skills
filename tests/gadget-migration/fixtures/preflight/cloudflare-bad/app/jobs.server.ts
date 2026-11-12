import { Worker } from "bullmq";
import { notifyExternalSystem } from "./services/external.server";

const worker = new Worker("external", async (job) => await notifyExternalSystem(job.data), { connection: { url: process.env.REDIS_URL } });
