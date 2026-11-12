import type { ActionFunctionArgs } from "react-router";
import { handleSchedule } from "@vercel/schedules";
import { pruneAuditLogs } from "../services/audit-logs.server";

const handler = handleSchedule(async (metadata) => {
  await pruneAuditLogs(metadata.executionId);
});

export const action = async ({ request }: ActionFunctionArgs) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get("authorization") !== `Bearer ${cronSecret}`) return new Response("Unauthorized", { status: 401 });
  return await handler(request);
};
