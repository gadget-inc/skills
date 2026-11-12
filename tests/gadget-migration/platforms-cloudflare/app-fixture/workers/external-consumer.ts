// the guide's queue handler, from "Limit concurrency per store", as a function workers/app.ts exports as queue
import { notifyExternalSystem, type ExternalJob } from "../app/services/external.server";

export async function consumeExternal(batch: MessageBatch<ExternalJob>, env: Env) {
  for (const message of batch.messages) {
    // failures from earlier copies of this job, plus this copy's earlier deliveries
    const failures = (message.body.failures ?? 0) + message.attempts - 1;
    const gate = env.SHOP_GATE.getByName(message.body.shopId);
    // the lease lasts 15 minutes, the longest a consumer can run
    if (!(await gate.acquire(message.id, 2, 15 * 60 * 1000))) {
      await env.EXTERNAL_QUEUE.send({ ...message.body, failures }, { delaySeconds: 30 });
      message.ack();
      continue;
    }
    try {
      await notifyExternalSystem(message.body);
      message.ack();
    } catch (error) {
      if (failures < 6) {
        // 6 retries starting 1 second apart and doubling, like a Gadget background action
        message.retry({ delaySeconds: 2 ** failures });
      } else {
        console.error("giving up after 7 attempts", message.body, error);
        message.ack();
      }
    } finally {
      await gate.release(message.id);
    }
  }
}
