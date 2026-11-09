import type { GadgetSettings } from "gadget-server";

export const settings: GadgetSettings = {
  type: "gadget/settings/v1",
  frameworkVersion: "v1.7.0",
  plugins: {
    connections: {
      shopify: {
        apiVersion: "2026-04",
        enabledModels: ["shopifyOrder"],
        type: "partner",
      },
    },
    authentications: {
      signInPath: "/sign-in",
      methods: { emailPassword: true, googleOAuth: { scopes: ["email", "profile"] } },
    },
  },
};
