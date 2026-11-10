import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { inngest } from "../inngest.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  await inngest.send({
    name: "app/orders.audit",
    data: { shopId: shop, orderId: String(payload.id) },
  });
  return new Response();
};
