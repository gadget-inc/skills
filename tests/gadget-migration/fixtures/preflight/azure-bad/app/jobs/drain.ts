import { DefaultAzureCredential } from "@azure/identity";
import { ServiceBusClient } from "@azure/service-bus";
import { reconcileShop } from "../services/reconcile.server";

const client = new ServiceBusClient(`${process.env.SERVICE_BUS_NAMESPACE}.servicebus.windows.net`, new DefaultAzureCredential());
const receiver = client.createReceiver("long-jobs", {
  receiveMode: "receiveAndDelete",
});
const [message] = await receiver.receiveMessages(1, { maxWaitTimeInMs: 30_000 });
if (message) await reconcileShop(message.body.shopId);
await client.close();
