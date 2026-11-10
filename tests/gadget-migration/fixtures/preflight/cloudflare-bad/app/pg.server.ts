import { env } from "cloudflare:workers";
import { Client } from "pg";

export const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
