import type { LoaderFunctionArgs } from "react-router";
import { reconcileShops } from "../services/reconcile.server";

// the schedule sets "requestMethod": "GET", so the loader handles it
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) return new Response("Unauthorized", { status: 401 });
  await reconcileShops();
  return new Response("ok");
};
