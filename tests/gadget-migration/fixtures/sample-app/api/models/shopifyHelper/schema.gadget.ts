import type { GadgetModel } from "gadget-server";

// a custom model whose name starts with "shopify": Shopify can't backfill it
export const schema: GadgetModel = {
  type: "gadget/model-schema/v1",
  storageKey: "kT4xQ9",
  fields: {
    hint: { type: "string", storageKey: "h1" },
  },
};
