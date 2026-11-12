// in scripts/enqueue-scheduled.ts
// One script for every scheduled action: each scheduled job runs it with its action's name, such as
// node build/enqueue-scheduled.js pruneAuditLogs, and the worker does the work with the queue's retries.
import { DefaultAzureCredential } from "@azure/identity";
import { ServiceBusClient } from "@azure/service-bus";
import { lastScheduledRun } from "../app/scheduled-time.server";

// the same cron expression as each job's --cron-expression, in UTC
const SCHEDULES: Record<string, string> = {
  pruneAuditLogs: "0 2 * * *",
  reconcileShops: "0 * * * *",
};

const job = process.argv[2];
const schedule = SCHEDULES[job];
if (!schedule) throw new Error(`no schedule for ${job}: add it to SCHEDULES`);

const credential = new DefaultAzureCredential({ managedIdentityClientId: process.env.AZURE_CLIENT_ID });
const client = new ServiceBusClient(`${process.env.SERVICE_BUS_NAMESPACE}.servicebus.windows.net`, credential);
const scheduledAt = lastScheduledRun(schedule).toISOString();
// one id per scheduled run, so a late start or a retry of the same run adds nothing to the queue
await client.createSender("scheduled").sendMessages({ body: { job, scheduledAt }, messageId: `${job}-${scheduledAt}` });
await client.close();
