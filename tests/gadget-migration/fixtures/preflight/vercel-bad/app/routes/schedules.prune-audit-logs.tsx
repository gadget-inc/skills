import { handleSchedule } from "@vercel/schedules";
import { pruneAuditLogs } from "../services/audit-logs.server";

export const action = handleSchedule(async (metadata) => {
  await pruneAuditLogs(metadata.executionId);
});
