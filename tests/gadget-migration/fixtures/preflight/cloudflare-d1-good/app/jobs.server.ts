import { env } from "cloudflare:workers";

// a ShopGate lease named for the job, with a limit of 1, in place of the Postgres advisory lock
export async function pruneAuditLogs(runId: string) {
  const gate = env.SHOP_GATE.getByName("prune-audit-logs");
  if (!(await gate.acquire(runId, 1, 15 * 60 * 1000))) return;
  try {
    const db = env.DB;
    await db.prepare("delete from audit_log where created_at < datetime('now', '-30 days')").run();
  } finally {
    await gate.release(runId);
  }
}
