import type { GadgetModel } from "gadget-server";

// a namespaced model, in the newer schema format
export const schema: GadgetModel = {
  type: "gadget/model-schema/v2",
  storageKey: "Invoice",
  searchIndex: false,
  fields: {
    number: { type: "string", validations: { required: true, unique: { caseSensitive: true } }, storageKey: "i1" },
    dueOn: { type: "dateTime", includeTime: false, storageKey: "i2" },
    status: { type: "enum", acceptUnlistedOptions: true, options: ["draft", "sent"], storageKey: "i3" },
    notes: { type: "richText", storageKey: "i4" },
    receipt: { type: "file", allowPublicAccess: true, storageKey: "i5" },
    widget: { type: "belongsTo", parent: { model: "widget" }, storageKey: "i6" },
  },
};
