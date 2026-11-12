import { Session } from "@shopify/shopify-api";
import { withDb } from "./db.server";

// one statement per method on a client opened per call, so nothing races to create tables
export const workerSessionStorage = {
  async storeSession(session: Session) {
    await withDb((db) => db.query("insert into shopify_session (id, shop, properties) values ($1, $2, $3) on conflict (id) do update set properties = excluded.properties", [session.id, session.shop, JSON.stringify(session.toPropertyArray(true))]));
    return true;
  },
  async loadSession(id: string) {
    const { rows } = await withDb((db) => db.query("select properties from shopify_session where id = $1", [id]));
    return rows[0] ? Session.fromPropertyArray(rows[0].properties, true) : undefined;
  },
};
