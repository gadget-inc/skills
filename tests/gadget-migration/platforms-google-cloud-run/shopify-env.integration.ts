// Reproduces the startup errors of a service that loads the template's shopify.server.ts without the
// Shopify variables, which google-cloud-run.md and the google-cloud-run/shopify-env-missing check quote.
// Run with: npm test (from this folder)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const dir = join(import.meta.dirname, ".typecheck", "shopify-env");
mkdirSync(dir, { recursive: true });
// the shopifyApp() call from Shopify's React Router template, with a session storage that needs no database
writeFileSync(
  join(dir, "shopify.server.mjs"),
  `import { shopifyApp, ApiVersion, AppDistribution } from "@shopify/shopify-app-react-router/server";
const sessionStorage = { storeSession: async () => true, loadSession: async () => undefined, deleteSession: async () => true, deleteSessions: async () => true, findSessionsByShop: async () => [] };
shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage,
  distribution: AppDistribution.AppStore,
});
console.log("started");
`
);

function start(env: Record<string, string>) {
  const result = spawnSync(process.execPath, [join(dir, "shopify.server.mjs")], { env: { PATH: process.env.PATH!, ...env }, encoding: "utf8" });
  return result.stdout + result.stderr;
}

const all = { SHOPIFY_APP_URL: "https://app.example.com", SHOPIFY_API_KEY: "production-client-id", SHOPIFY_API_SECRET: "secret", SCOPES: "write_products" };

describe("shopify.server.ts on a service without the Shopify variables (@shopify/shopify-app-react-router 3.0.2)", () => {
  it("starts with all of them", () => {
    assert.match(start(all), /started/);
  });

  it("stops without SHOPIFY_APP_URL", () => {
    const { SHOPIFY_APP_URL, ...rest } = all;
    assert.match(start(rest), /Detected an empty appUrl configuration/);
  });

  it("stops without SHOPIFY_API_KEY or SHOPIFY_API_SECRET", () => {
    const { SHOPIFY_API_KEY, ...noKey } = all;
    assert.match(start(noKey), /Missing values for: apiKey/);
    const { SHOPIFY_API_SECRET, ...noSecret } = all;
    assert.match(start(noSecret), /Missing values for: apiSecretKey/);
  });
});
