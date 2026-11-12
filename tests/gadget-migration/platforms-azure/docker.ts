// Throwaway containers for the Azure tests. Each test file uses its own containers, names, and ports,
// because node --test runs files in parallel. Nothing here needs an Azure account.
import { execFileSync, spawnSync } from "node:child_process";
import pg from "pg";

export function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function hasImage(image: string): boolean {
  return spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status === 0;
}

export function removeContainer(name: string) {
  spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
}

// PostgreSQL 17, the version the guide's and this reference's server runs
export const POSTGRES_IMAGE = process.env.POSTGRES_IMAGE ?? "postgres:17";
// PgBouncer 1.26.1, the version Flexible Server runs
export const PGBOUNCER_IMAGE = process.env.PGBOUNCER_IMAGE ?? "edoburu/pgbouncer:latest";
export const AZURITE_IMAGE = process.env.AZURITE_IMAGE ?? "mcr.microsoft.com/azure-storage/azurite:latest";

export async function waitFor(url: string, attempts = 100) {
  for (let i = 0; ; i++) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("select 1");
      await client.end();
      return;
    } catch (error) {
      await client.end().catch(() => {});
      if (i === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}
