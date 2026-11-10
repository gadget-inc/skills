import { withDb } from "../db.server";

export async function reconcileShop(shopId: string) {
  await withDb((db) => db.query("insert into reconcile_log (shop) values ($1)", [shopId]));
}
