import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { webhookSender } from "../queues.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, webhookId } = await authenticate.webhook(request);

  // a second delivery of the same webhook has the same id, and the queue drops it for a day
  await webhookSender.sendMessages({ body: { shop, topic, payload }, messageId: webhookId });
  return new Response();
};
