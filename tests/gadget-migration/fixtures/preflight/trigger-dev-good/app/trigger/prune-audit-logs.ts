import { schedules } from "@trigger.dev/sdk";
import { deleteAuditLogsOlderThan } from "../services/audit-logs.server";

export const pruneAuditLogs = schedules.task({
  id: "prune-audit-logs",
  concurrency: { total: 1 },
  ttl: "1h",
  run: async () => {
    await deleteAuditLogsOlderThan(90);
  },
});
