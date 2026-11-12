// Creates a fresh scratch database for one test file, so node --test can run the files in parallel.
import pg from "pg";

export const DATABASE_URL = process.env.DATABASE_URL;
export const skip = !DATABASE_URL && "set DATABASE_URL to a Postgres superuser URL";

export async function scratchDatabase(name: string): Promise<{ admin: pg.Pool; url: string }> {
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
  return { admin: new pg.Pool({ connectionString: url.toString() }), url: url.toString() };
}
