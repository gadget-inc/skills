import { DefaultAzureCredential } from "@azure/identity";
import { ServiceBusClient } from "@azure/service-bus";

const client = new ServiceBusClient(`${process.env.SERVICE_BUS_NAMESPACE}.servicebus.windows.net`, new DefaultAzureCredential());
// one id per day
const day = new Date().toISOString().slice(0, 10);
await client.createSender("scheduled").sendMessages({ body: { job: "pruneAuditLogs" }, messageId: `pruneAuditLogs-${day}` });
await client.close();
