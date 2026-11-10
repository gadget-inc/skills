// the guide's ReconcileShop with a lease, from "Limit concurrency per store"
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { reconcileShop } from "../../app/services/reconcile.server";

export class ReconcileShop extends WorkflowEntrypoint<Env, { shopId: string }> {
  async run(event: WorkflowEvent<{ shopId: string }>, step: WorkflowStep) {
    const gate = this.env.SHOP_GATE.getByName(event.payload.shopId);
    // longer than the step's 30-minute timeout, so the lease outlasts each attempt
    const leaseMs = 35 * 60 * 1000;
    for (let attempt = 1; ; attempt++) {
      const acquired = await step.do(`acquire lease ${attempt}`, async () => await gate.acquire(event.instanceId, 2, leaseMs));
      if (acquired) break;
      await step.sleep(`wait for lease ${attempt}`, "30 seconds");
    }
    try {
      await step.do("reconcile", { timeout: "30 minutes", retries: { limit: 6, delay: "1 second", backoff: "exponential" } }, async () => {
        // renews the lease, or fails this attempt to retry later if another job took the slot during a pause
        if (!(await gate.acquire(event.instanceId, 2, leaseMs))) throw new Error("lease lost");
        await reconcileShop(event.payload.shopId);
      });
    } finally {
      // releases the lease even when every attempt fails
      await step.do("release lease", async () => await gate.release(event.instanceId));
    }
  }
}
