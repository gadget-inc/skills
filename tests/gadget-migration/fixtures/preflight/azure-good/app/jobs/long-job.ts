import { randomUUID } from "node:crypto";
import { DefaultAzureCredential } from "@azure/identity";
import { ServiceBusClient } from "@azure/service-bus";
import pg from "pg";
import { reconcileShop } from "../services/reconcile.server";

const credential = new DefaultAzureCredential({ managedIdentityClientId: process.env.AZURE_CLIENT_ID });
const client = new ServiceBusClient(`${process.env.SERVICE_BUS_NAMESPACE}.servicebus.windows.net`, credential);
// renews the message's lock for up to an hour, the job's --replica-timeout
const receiver = client.createReceiver("long-jobs", { maxAutoLockRenewalDurationInMs: 60 * 60 * 1000 });

const [message] = await receiver.receiveMessages(1, { maxWaitTimeInMs: 30_000 });
if (message) {
  const { shopId } = message.body;
  // app_user on port 5432, because PgBouncer's transaction mode does not keep a session-level lock
  const db = new pg.Client({ connectionString: process.env.LOCK_DATABASE_URL });
  await db.connect();
  // held until this connection closes, which also happens when the execution crashes
  const { rows } = await db.query("select pg_try_advisory_lock(hashtextextended('reconcile:' || $1, 0)) as locked", [shopId]);
  if (rows[0].locked) {
    await reconcileShop(shopId);
  } else {
    // another execution is reconciling this store, so try again in 5 minutes instead of waiting
    // a fresh 36-character id for each copy, because Service Bus refuses an id over 128 characters
    await client
      .createSender("long-jobs")
      .scheduleMessages({ body: message.body, messageId: randomUUID() }, new Date(Date.now() + 5 * 60 * 1000));
  }
  // an error before this line leaves the message for the next execution once its lock expires
  await receiver.completeMessage(message);
  await db.end();
}
await client.close();
