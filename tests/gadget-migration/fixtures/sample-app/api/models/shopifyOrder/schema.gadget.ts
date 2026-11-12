import type { GadgetModel } from "gadget-server";

export const schema: GadgetModel = {
  type: "gadget/model-schema/v1",
  storageKey: "DataModel-Shopify-Order",
  fields: {
    reviewed: { type: "boolean", storageKey: "o1" },
  },
  shopify: { fields: ["email", "totalPrice", "shopifyUpdatedAt", "shop"] },
};
