import type { ActionFunctionArgs } from "react-router";

// every schedule route wraps its job in this, so each one checks CRON_SECRET before doing any work
export function scheduleRoute(job: () => Promise<void>) {
  return async ({ request }: ActionFunctionArgs) => {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret || request.headers.get("authorization") !== `Bearer ${cronSecret}`) return new Response("Unauthorized", { status: 401 });
    await job();
    return new Response();
  };
}
