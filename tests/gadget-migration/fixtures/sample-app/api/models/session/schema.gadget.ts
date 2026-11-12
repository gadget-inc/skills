import type { GadgetModel } from "gadget-server";

// the session model lists Shopify fields without being a Shopify model
export const schema: GadgetModel = {
  type: "gadget/model-schema/v1",
  storageKey: "Session",
  fields: {
    roles: { type: "roleList", default: ["unauthenticated"], storageKey: "s1" },
  },
  shopify: { fields: ["shop", "shopifySID"] },
};
