import type { GadgetModel } from "gadget-server";

export const schema: GadgetModel = {
  type: "gadget/model-schema/v1",
  storageKey: "DataModel-Shopify-Product",
  fields: {
    // synced from a Shopify metafield, so Shopify holds the value
    careGuide: {
      type: "string",
      shopifyMetafield: { privateMetafield: false, namespace: "custom", key: "care_guide", metafieldType: "single_line_text_field", allowMultipleEntries: false },
      storageKey: "p1",
    },
    // added by the app, so only Gadget holds the value
    featured: { type: "boolean", default: false, storageKey: "p2" },
    widgets: { type: "hasMany", children: { model: "widget", belongsToField: "product" }, storageKey: "p3" },
  },
  shopify: { fields: ["title", "handle", "shop"] },
};
