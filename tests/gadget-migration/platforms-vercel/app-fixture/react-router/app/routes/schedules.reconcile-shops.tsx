// the guide's schedule route, from "Replace scheduled actions"
import type { ActionFunctionArgs } from "react-router";
import { handleSchedule } from "@vercel/schedules";

const handler = handleSchedule(async (metadata) => {
  console.log(`reconcile-shops run ${metadata.executionId}`);
});

export const action = async ({ request }: ActionFunctionArgs) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  return await handler(request);
};
