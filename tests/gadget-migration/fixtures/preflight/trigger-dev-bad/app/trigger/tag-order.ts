import { task } from "@trigger.dev/sdk";
import { tagOrder } from "../services/shopify-orders.server";

export const tagOrderTask = task({
  id: "tag-order",
  run: async (payload: { shop: string; accessToken: string; orderId: string }) => {
    await tagOrder(payload.shop, payload.accessToken, payload.orderId);
  },
});
