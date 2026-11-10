import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { hasHookdeckSignature } from "../hookdeck.server";
import { handleOrderUpdated, type OrderWebhookPayload } from "../services/orders.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!hasHookdeckSignature(request, await request.clone().text())) {
    return new Response(undefined, { status: 401 });
  }
  const { shop, payload, webhookId } = await authenticate.webhook(request);
  await handleOrderUpdated(shop, webhookId, payload as OrderWebhookPayload);
  return new Response();
};
