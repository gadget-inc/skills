import { shopifyApp } from "@shopify/shopify-app-react-router/server";
import { workerSessionStorage } from "./sessions.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  appUrl: process.env.SHOPIFY_APP_URL || "",
  sessionStorage: workerSessionStorage,
});

export default shopify;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
