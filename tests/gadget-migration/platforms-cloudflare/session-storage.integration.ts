// Reproduces the failure signature in references/platforms/cloudflare.md for Shopify's PostgreSQL session
// storage created per call: on an empty database, concurrent first calls race to create its tables.
// The race runs in a child process, because the storage's constructor rejects without anyone awaiting it.
// Needs DATABASE_URL for a Postgres superuser, to create and drop the cloudflare_race database.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";

const ADMIN_URL = process.env.DATABASE_URL;
const url = ADMIN_URL ? Object.assign(new URL(ADMIN_URL), { pathname: "/cloudflare_race" }).toString() : "";

const RACE = `
import { PostgreSQLSessionStorage } from "@shopify/shopify-app-session-storage-postgresql";
process.on("unhandledRejection", () => {});
const results = await Promise.allSettled(Array.from({ length: 10 }, async () => {
  const storage = new PostgreSQLSessionStorage(process.env.RACE_URL);
  try { return await storage.loadSession("offline_example.myshopify.com"); } finally { await storage.disconnect().catch(() => {}); }
}));
console.log(JSON.stringify(results.map((r) => (r.status === "fulfilled" ? "ok" : String(r.reason?.message)))));
`;

describe("PostgreSQLSessionStorage created per call", { skip: !ADMIN_URL && "set DATABASE_URL" }, () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });

  before(async () => {
    await admin.connect();
    await admin.query("drop database if exists cloudflare_race with (force)");
    await admin.query("create database cloudflare_race");
  });

  after(async () => {
    await admin.query("drop database if exists cloudflare_race with (force)");
    await admin.end();
  });

  it("fails concurrent first calls on an empty database with duplicate key errors", () => {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", RACE], { cwd: fileURLToPath(new URL(".", import.meta.url)), env: { ...process.env, RACE_URL: url }, encoding: "utf8" });
    const results: string[] = JSON.parse(child.stdout.trim().split("\n").pop()!);
    const failures = results.filter((r) => r !== "ok");
    assert.ok(failures.length >= 5, `${failures.length} of 10 failed: ${results.join(", ")}`);
    assert.ok(failures.some((f) => f.includes('duplicate key value violates unique constraint "pg_type_typname_nsp_index"')), results.join("\n"));
  });
});
