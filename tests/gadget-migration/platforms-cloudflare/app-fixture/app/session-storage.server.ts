// the guide's workerSessionStorage, from "Run Shopify's app template on Workers"
import { Session } from "@shopify/shopify-api";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import { withDb } from "./db.server";

export const workerSessionStorage: SessionStorage = {
  async storeSession(session) {
    const properties = JSON.stringify(session.toPropertyArray(true));
    await withDb((db) =>
      db.query(
        "insert into shopify_session (id, shop, properties) values ($1, $2, $3) on conflict (id) do update set shop = excluded.shop, properties = excluded.properties",
        [session.id, session.shop, properties]
      )
    );
    return true;
  },
  async loadSession(id) {
    const { rows } = await withDb((db) => db.query("select properties from shopify_session where id = $1", [id]));
    return rows[0] ? Session.fromPropertyArray(rows[0].properties, true) : undefined;
  },
  async deleteSession(id) {
    await withDb((db) => db.query("delete from shopify_session where id = $1", [id]));
    return true;
  },
  async deleteSessions(ids) {
    await withDb((db) => db.query("delete from shopify_session where id = any($1)", [ids]));
    return true;
  },
  async findSessionsByShop(shop) {
    const { rows } = await withDb((db) => db.query("select properties from shopify_session where shop = $1", [shop]));
    return rows.map((row) => Session.fromPropertyArray(row.properties, true));
  },
};
