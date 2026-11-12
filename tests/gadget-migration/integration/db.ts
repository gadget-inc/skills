// Creates a fresh scratch database for one integration test file. Each file uses its own database
// name, so node --test can run the files in parallel.
import pg from "pg";

export const DATABASE_URL = process.env.DATABASE_URL;
export const REDIS_URL = process.env.REDIS_URL;
export const skipWithoutDatabase = !DATABASE_URL && "set DATABASE_URL to a Postgres superuser URL";
export const skipWithoutRedis = skipWithoutDatabase || (!REDIS_URL && "set REDIS_URL");

export async function scratchDatabase(name: string): Promise<{ admin: pg.Pool; url: URL }> {
  const bootstrap = new pg.Client({ connectionString: DATABASE_URL });
  await bootstrap.connect();
  try {
    await bootstrap.query(`drop database if exists ${name}`);
    await bootstrap.query(`create database ${name}`);
  } finally {
    await bootstrap.end();
  }
  const url = new URL(DATABASE_URL!);
  url.pathname = `/${name}`;
  return { admin: new pg.Pool({ connectionString: url.toString() }), url };
}

export function redisConnection() {
  const url = new URL(REDIS_URL!);
  return { host: url.hostname, port: Number(url.port || 6379) };
}
