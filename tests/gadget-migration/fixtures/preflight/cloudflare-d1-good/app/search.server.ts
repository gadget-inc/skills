import { env } from "cloudflare:workers";

// like ignores case for ASCII letters in SQLite, and json_extract reads the JSON column
const SEARCH = `select id from product
  where title like ?
  and json_extract(metadata, '$.active') = 1`;

export const searchProducts = (term: string) => env.DB.prepare(SEARCH).bind(`%${term}%`).all();
