import { env } from "cloudflare:workers";
import { Client } from "pg";

// a Worker cannot use a connection that another request opened, so each call opens its own
export async function withDb<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}
