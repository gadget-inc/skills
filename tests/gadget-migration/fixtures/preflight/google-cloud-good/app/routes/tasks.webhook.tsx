import type { ActionFunctionArgs } from "react-router";
import { handleWebhook } from "../services/webhooks.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (process.env.K_SERVICE !== "my-app-worker") return new Response(null, { status: 404 });
  const { shop, topic, payload } = await request.json();
  await handleWebhook(shop, topic, payload);
  return new Response();
};
