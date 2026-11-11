import { env } from "cloudflare:workers";

// the Postgres app's queries, sent to D1 unchanged
export async function widgetsForShop(shopId: string) {
  await env.DB.prepare("select set_config('app.shop_id', ?, true)").bind(shopId).run();
  return (await env.DB.prepare("select id from widget where id = any(?)").bind("[1,2]").all()).results;
}

export async function countWidgets() {
  return await env.DB.prepare("select count(*)::int as n from widget").first<{ n: number }>();
}

export async function moveWidget(id: number, shopId: string) {
  console.log("widgets::moved", id);
  await env.DB.prepare("BEGIN TRANSACTION").run();
  await env.DB.prepare("update widget set shop_id = ? where id = ?").bind(shopId, id).run();
  await env.DB.prepare("COMMIT").run();
}
