import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { saveOrder } from "../services/orders.server";

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  context.cloudflare.ctx.waitUntil(saveOrder(shop, payload));
  return new Response();
};
