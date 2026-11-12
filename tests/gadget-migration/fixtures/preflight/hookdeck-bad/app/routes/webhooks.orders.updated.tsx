import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { handleOrderUpdated } from "../services/orders.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const order = await request.json();
  const { shop, webhookId } = await authenticate.webhook(request);
  await handleOrderUpdated(shop, webhookId, order);
  return new Response();
};
