import type { ActionFunctionArgs } from "react-router";
import { handleWebhook } from "../services/webhooks.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await request.json();
  await handleWebhook(shop, topic, payload);
  return new Response();
};
