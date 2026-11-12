import type { ActionFunctionArgs } from "react-router";
import { waitUntil } from "@vercel/functions";
import { authenticate } from "../shopify.server";
import { saveOrder } from "../services/orders.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  waitUntil(saveOrder(shop, payload));
  return new Response();
};
