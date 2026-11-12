import { withDb } from "../db.server";

export type ExternalJob = { shopId: string; orderId: string; failures?: number };

export async function notifyExternalSystem(job: ExternalJob) {
  await withDb((db) => db.query("insert into external_log (shop_id, order_id) values ($1, $2)", [job.shopId, job.orderId]));
}
