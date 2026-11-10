import { schedules } from "@trigger.dev/sdk";
import { deleteAuditLogsOlderThan } from "../services/audit-logs.server";

export const pruneAuditLogs = schedules.task({
  id: "prune-audit-logs",
  cron: "0 2 * * *",
  run: async () => {
    await deleteAuditLogsOlderThan(90);
  },
});
