// the guide's ShopGate, from "Limit concurrency per store"
import { DurableObject } from "cloudflare:workers";

// one object per store, named after the store's id
export class ShopGate extends DurableObject<Env> {
  // these methods never await, so two calls for the same store never interleave
  acquire(jobId: string, limit: number, leaseMs: number): boolean {
    const now = Date.now();
    const leases = this.ctx.storage.kv.get<Record<string, number>>("leases") ?? {};
    for (const [id, expiresAt] of Object.entries(leases)) {
      // a lease left behind by a consumer that crashed expires on its own
      if (expiresAt < now) delete leases[id];
    }
    if (!(jobId in leases) && Object.keys(leases).length >= limit) return false;
    leases[jobId] = now + leaseMs;
    this.ctx.storage.kv.put("leases", leases);
    return true;
  }

  release(jobId: string): void {
    const leases = this.ctx.storage.kv.get<Record<string, number>>("leases") ?? {};
    delete leases[jobId];
    this.ctx.storage.kv.put("leases", leases);
  }
}
