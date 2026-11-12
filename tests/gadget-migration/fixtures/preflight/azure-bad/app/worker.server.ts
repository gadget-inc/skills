import { DefaultAzureCredential } from "@azure/identity";
import { ServiceBusClient } from "@azure/service-bus";
import { handleWebhook } from "./services/webhooks.server";

const client = new ServiceBusClient(`${process.env.SERVICE_BUS_NAMESPACE}.servicebus.windows.net`, new DefaultAzureCredential());
const receiver = client.createReceiver("webhooks");

const subscription = receiver.subscribe(
  {
    processMessage: async (message) => {
      await handleWebhook(message.body);
    },
    processError: async ({ error }) => console.error(error),
  },
  { maxConcurrentCalls: 10 }
);

process.on("SIGTERM", async () => {
  await subscription.close();
  await client.close();
  process.exit(0);
});
