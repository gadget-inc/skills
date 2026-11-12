import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { inngest } from "../inngest.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, webhookId } = await authenticate.webhook(request);
  await inngest.send({ id: webhookId, name: "shopify/orders.create", data: { shop, topic, payload } });
  return new Response();
};
