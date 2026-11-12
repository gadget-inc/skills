// The PruneAuditLogs Workflow that references/platforms/cloudflare.md describes: one step per batch,
// so a retry repeats one batch and no statement nears Hyperdrive's 60-second limit.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { withDb } from "../../app/db.server";

const BATCH = 5000;

export class PruneAuditLogs extends WorkflowEntrypoint<Env> {
  async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    for (let batch = 1; ; batch++) {
      // 4 retries make the 5 attempts Gadget gave a scheduled action
      const deleted = await step.do(`delete batch ${batch}`, { retries: { limit: 4, delay: "1 second", backoff: "exponential" } }, async () =>
        withDb(async (db) => {
          const result = await db.query("delete from audit_log where id in (select id from audit_log where created_at < now() - interval '90 days' limit $1)", [BATCH]);
          return result.rowCount ?? 0;
        })
      );
      if (deleted < BATCH) return { batches: batch };
    }
  }
}
