import { DefaultAzureCredential } from "@azure/identity";
import { ServiceBusClient } from "@azure/service-bus";

const credential = new DefaultAzureCredential({ managedIdentityClientId: process.env.AZURE_CLIENT_ID });
const client = new ServiceBusClient(`${process.env.SERVICE_BUS_NAMESPACE}.servicebus.windows.net`, credential);
export const webhookSender = client.createSender("webhooks");
