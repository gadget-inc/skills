// Starts Supabase's Postgres image in Docker for one test file, and writes reference blocks to disk
// so they run from this folder, where node_modules resolves.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { block } from "../platform-blocks.ts";

export const IMAGE = "public.ecr.aws/supabase/postgres:17.11.0.018";
export const testDir = dirname(fileURLToPath(import.meta.url));

export function dockerSkip(): string | false {
  const docker = spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" });
  return docker.status === 0 ? false : `needs Docker and the ${IMAGE} image`;
}

// Starts a fresh container and resolves with the URL for the postgres role once init has finished.
export async function startSupabasePostgres(name: string, port: number): Promise<string> {
  spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  execFileSync("docker", ["run", "-d", "--name", name, "-e", "POSTGRES_PASSWORD=postgres", "-p", `127.0.0.1:${port}:5432`, IMAGE], { stdio: "ignore" });
  const url = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (logs(name).includes("PostgreSQL init process complete")) {
      const client = new pg.Client({ connectionString: url });
      try {
        await client.connect();
        await client.query("select 1");
        await client.end();
        return url;
      } catch {
        await client.end().catch(() => {});
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${name} did not start: ${logs(name).slice(-2000)}`);
}

export function stopSupabasePostgres(name: string) {
  spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
}

export function logs(name: string): string {
  const out = spawnSync("docker", ["logs", name], { encoding: "utf8" });
  return `${out.stdout ?? ""}${out.stderr ?? ""}`;
}

export function urlFor(adminUrl: string, user: string, password: string): string {
  const url = new URL(adminUrl);
  url.username = user;
  url.password = password;
  return url.toString();
}

// Writes the reference's block for each path under dir, plus any extra files, and returns dir.
export function writeBlocks(dir: string, paths: string[], extra: Record<string, string> = {}): string {
  const files: Record<string, string> = { ...Object.fromEntries(paths.map((p) => [p, block("supabase.md", p)])), ...extra };
  for (const [path, code] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), code);
  }
  return dir;
}

export const sql = (path: string) => block("supabase.md", path);

export const MIGRATIONS = ["supabase/migrations/20261109000000_app_server_role.sql", "supabase/migrations/20261109000100_tables.sql"];
