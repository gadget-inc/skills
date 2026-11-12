// Preloaded with --import by shopify-token-move.test.ts.
//
// It stands in for Shopify's token endpoint: FAKE_TOKEN_STATUS is a JSON object of store domain to
// HTTP status, and any store not named answers 200 with a new pair of tokens. Each request is
// appended to FAKE_FETCH_LOG.
//
// It also lets the script import "../app/shopify/tokens.server" without an extension, the way a
// bundler or tsx resolves it.
import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith(".")) throw error;
      return nextResolve(`${specifier}.ts`, context);
    }
  },
});

const statuses = JSON.parse(process.env.FAKE_TOKEN_STATUS ?? "{}");

globalThis.fetch = async (url, init) => {
  const { hostname, pathname } = new URL(url);
  if (pathname !== "/admin/oauth/access_token") throw new Error(`unexpected request to ${url}`);
  const form = Object.fromEntries(init.body);
  appendFileSync(process.env.FAKE_FETCH_LOG, JSON.stringify({ shop: hostname, grant_type: form.grant_type, subject_token: form.subject_token }) + "\n");
  const status = statuses[hostname] ?? 200;
  if (status !== 200) return new Response(JSON.stringify({ error: "invalid_request" }), { status });
  return new Response(
    JSON.stringify({ access_token: `new-access-${hostname}`, scope: "read_orders", expires_in: 3600, refresh_token: `new-refresh-${hostname}`, refresh_token_expires_in: 7776000 }),
    { status: 200 }
  );
};
