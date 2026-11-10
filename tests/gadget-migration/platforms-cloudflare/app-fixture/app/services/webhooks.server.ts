import { withDb } from "../db.server";

export async function handleWebhook(shop: string, topic: string, payload: unknown) {
  await withDb((db) => db.query("insert into webhook_log (shop, topic, payload) values ($1, $2, $3)", [shop, topic, JSON.stringify(payload)]));
}
