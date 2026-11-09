import type { GadgetModel } from "gadget-server";

export const schema: GadgetModel = {
  type: "gadget/model-schema/v1",
  storageKey: "Widget",
  fields: {
    name: { type: "string", validations: { required: true }, storageKey: "w1" },
    sku: { type: "string", validations: { unique: { scopeByField: "shop" } }, storageKey: "w2" },
    price: { type: "number", decimals: 2, storageKey: "w3" },
    tags: { type: "enum", acceptMultipleSelections: true, options: ["new", "sale"], storageKey: "w4" },
    apiSecret: { type: "encryptedString", storageKey: "w5" },
    embedding: { type: "vector", storageKey: "w6" },
    displayName: { type: "computed", sourceFile: "api/models/widget/displayName.gelly", storageKey: "w7" },
    shop: { type: "belongsTo", parent: { model: "shopifyShop" }, storageKey: "w8" },
    manual: { type: "file", allowPublicAccess: false, storageKey: "w9" },
  },
};
