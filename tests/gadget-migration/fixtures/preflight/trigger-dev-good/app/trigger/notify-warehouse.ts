import { task } from "@trigger.dev/sdk";
import { notifyWarehouse } from "../services/warehouse.server";

// calls the warehouse's own API, not Shopify's, so Shopify's IP allowlist doesn't apply
export const notifyWarehouseTask = task({
  id: "notify-warehouse",
  run: async (payload: { orderId: string }) => {
    await notifyWarehouse(payload.orderId);
  },
});
