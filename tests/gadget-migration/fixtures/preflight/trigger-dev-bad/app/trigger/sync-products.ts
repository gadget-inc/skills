import { task } from "@trigger.dev/sdk";
import { unauthenticated } from "../shopify.server";

export const syncProductsTask = task({
  id: "sync-products",
  run: async (payload: { shop: string }) => {
    const { admin } = await unauthenticated.admin(payload.shop);
    const response = await admin.graphql(`#graphql
      query { products(first: 50) { nodes { id title } } }`);
    console.log(await response.json());
  },
});
