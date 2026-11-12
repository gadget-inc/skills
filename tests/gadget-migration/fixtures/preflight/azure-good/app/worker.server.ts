import { DefaultAzureCredential } from "@azure/identity";
import { ServiceBusClient, type ServiceBusReceivedMessage } from "@azure/service-bus";
import { handleWebhook } from "./services/webhooks.server";

// AZURE_CLIENT_ID picks the user-assigned identity
const credential = new DefaultAzureCredential({ managedIdentityClientId: process.env.AZURE_CLIENT_ID });
const client = new ServiceBusClient(`${process.env.SERVICE_BUS_NAMESPACE}.servicebus.windows.net`, credential);
const sender = client.createSender("webhooks");
// renews each message's 1-minute lock for up to 15 minutes, so a slow message is not delivered twice
const receiver = client.createReceiver("webhooks", { maxAutoLockRenewalDurationInMs: 15 * 60 * 1000 });

async function processWebhook(message: ServiceBusReceivedMessage) {
  try {
    await handleWebhook(message.body);
  } catch (error) {
    const attempt = Number(message.applicationProperties?.attempt ?? 1);
    // the first message's id, carried on every copy so copy ids stay under the 128-character limit
    const firstId = String(message.applicationProperties?.firstMessageId ?? message.messageId);
    if (attempt >= 10) {
      await receiver.deadLetterMessage(message, { deadLetterReason: "AttemptsExhausted", deadLetterErrorDescription: String(error) });
      return;
    }
    // a copy with its own id, because the queue drops a second message with the original id for a day
    // waits 2 seconds, then 4, then 8, close to Gadget's webhook retries, which also randomize each wait
    await sender.scheduleMessages(
      {
        body: message.body,
        messageId: `${firstId}-${attempt + 1}`,
        sessionId: message.sessionId,
        applicationProperties: { attempt: attempt + 1, firstMessageId: firstId },
      },
      new Date(Date.now() + 2 ** attempt * 1000)
    );
  }
  await receiver.completeMessage(message);
}

let running = 0;
const subscription = receiver.subscribe(
  {
    processMessage: async (message) => {
      running++;
      try {
        await processWebhook(message);
      } catch (error) {
        // hands the message back at once, instead of holding its lock until renewal stops
        await receiver.abandonMessage(message);
        throw error;
      } finally {
        running--;
      }
    },
    processError: async ({ error }) => console.error(error),
  },
  // processWebhook settles each message itself, so running only drops once the message is settled
  { maxConcurrentCalls: 10, autoCompleteMessages: false }
);

process.on("SIGTERM", async () => {
  // stops taking messages and waits for the running ones, until Container Apps stops the replica
  await subscription.close();
  while (running > 0) await new Promise((resolve) => setTimeout(resolve, 500));
  await client.close();
  process.exit(0);
});
