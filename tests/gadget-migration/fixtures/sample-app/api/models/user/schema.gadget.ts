import type { GadgetModel } from "gadget-server";

export const schema: GadgetModel = {
  type: "gadget/model-schema/v1",
  storageKey: "User",
  fields: {
    email: { type: "email", validations: { required: true, unique: true }, storageKey: "u1" },
    password: { type: "password", validations: { strongPassword: true }, storageKey: "u2" },
    roles: { type: "roleList", default: ["unauthenticated"], storageKey: "u3" },
  },
};
