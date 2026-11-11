import { env } from "cloudflare:workers";

const SEARCH = `select id from product
  where title ilike ?
  and metadata @> ?`;

export const searchProducts = (term: string) => env.DB.prepare(SEARCH).bind(`%${term}%`, JSON.stringify({ active: true })).all();
