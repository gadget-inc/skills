import { env } from "cloudflare:workers";

// tenancy in each query, since D1 has no row-level security
export async function widgetsForShop(shopId: string) {
  return (await env.DB.prepare("select id, tags ->> '$[0]' as first_tag from widget where shop_id = ?").bind(shopId).all()).results;
}

export async function countWidgets() {
  return await env.DB.prepare("select cast(count(*) as integer) as n from widget").first<{ n: number }>();
}

// one batch is one transaction, so D1 needs no BEGIN TRANSACTION or COMMIT
export async function moveWidget(id: number, shopId: string) {
  console.log("widgets::moved", id);
  await env.DB.batch([
    env.DB.prepare("update widget set shop_id = ? where id = ?").bind(shopId, id),
    env.DB.prepare("insert into widget_move (widget_id, shop_id) values (?, ?) on conflict (widget_id) do update set shop_id = excluded.shop_id where widget_move.shop_id <> excluded.shop_id").bind(id, shopId),
  ]);
}
