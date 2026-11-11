import { env } from "cloudflare:workers";

// the nightly prune, which held an advisory lock so two runs never overlap
export async function pruneAuditLogs() {
  const db = env.DB;
  const lock = await db.prepare("select pg_try_advisory_xact_lock(42) as locked").first<{ locked: number }>();
  if (!lock?.locked) return;
  await db.prepare("delete from audit_log where created_at < datetime('now', '-30 days')").run();
}
