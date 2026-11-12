// the guide's webhook route, from "Receive webhooks"
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shop, topic, payload, webhookId } = await authenticate.webhook(request);

  const { errors } = await context.cloudflare.env.PROCESS_WEBHOOK.createBatch({
    instances: [{ id: webhookId, params: { shop, topic, payload } }],
  });
  for (const error of errors) {
    // 10405 means an earlier delivery of this webhook already started its instance
    if (error.code !== 10405) throw new Error(error.message);
  }
  return new Response();
};
