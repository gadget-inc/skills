import { withDb } from "./db.server";

export const countSessions = () => withDb(async (db) => (await db.query("select count(*) from shopify_session")).rows[0].count);
