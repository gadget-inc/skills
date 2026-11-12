import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { hasHookdeckSignature } from "../hookdeck.server";
import { handleOrderUpdated, type OrderWebhookPayload } from "../services/orders.server";

// Shopify's HMAC covers the raw bytes, so never call request.json() before authenticate.webhook.
export const action = async ({ request }: ActionFunctionArgs) => {
  if (!hasHookdeckSignature(request, await request.clone().text())) {
    return new Response(undefined, { status: 401 });
  }
  const { shop, payload, webhookId } = await authenticate.webhook(request);
  await handleOrderUpdated(shop, webhookId, payload as OrderWebhookPayload);
  return new Response();
};
