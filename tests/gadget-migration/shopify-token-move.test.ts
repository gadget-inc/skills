// Runs scripts/move-shopify-tokens.ts and app/shopify/tokens.server.ts from
// references/shopify-tokens.md against stand-ins for the Gadget client, Prisma, and Shopify's token
// endpoint (fixtures/fake-token-move). Run with: node --test "tests/**/*.test.ts"
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { blocks } from "./integration/snippets.ts";

const fixtures = fileURLToPath(new URL("./fixtures/fake-token-move", import.meta.url));
const script = blocks("shopify-tokens.md", "scripts/move-shopify-tokens.ts")[0];
const tokensModule = blocks("shopify-tokens.md", "app/shopify/tokens.server.ts")[0];
const workDirs: string[] = [];

type Shop = { id: string; myshopifyDomain: string; accessToken: string; grantedScopes?: string[]; refreshToken?: string | null; accessTokenExpiresAt?: string | null; refreshTokenExpiresAt?: string | null };

// a store whose token Gadget got before API version 2026-04: it never expires and has no refresh token
const nonExpiring = (name: string): Shop => ({ id: name, myshopifyDomain: `${name}.myshopify.com`, accessToken: `gadget-access-${name}`, grantedScopes: ["read_orders"] });
// a store with an expiring pair
const expiring = (name: string): Shop => ({
  ...nonExpiring(name),
  refreshToken: `gadget-refresh-${name}`,
  accessTokenExpiresAt: "2026-11-09T11:00:00.000Z",
  refreshTokenExpiresAt: "2027-02-07T10:00:00.000Z",
});

// A scratch project laid out like the new app: the script, the token module it imports, and the
// two fake packages under node_modules.
function project(shops: Shop[], sessions: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gadget-token-move-"));
  workDirs.push(dir);
  mkdirSync(join(dir, "node_modules", "@gadget-client"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "@prisma"), { recursive: true });
  cpSync(join(fixtures, "gadget-client"), join(dir, "node_modules", "@gadget-client", "my-app"), { recursive: true });
  cpSync(join(fixtures, "prisma-client"), join(dir, "node_modules", "@prisma", "client"), { recursive: true });
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "app", "shopify"), { recursive: true });
  writeFileSync(join(dir, "scripts", "move-shopify-tokens.ts"), script);
  writeFileSync(join(dir, "app", "shopify", "tokens.server.ts"), tokensModule);
  writeFileSync(join(dir, "shops.json"), JSON.stringify(shops));
  writeFileSync(join(dir, "sessions.json"), JSON.stringify(sessions));
  return dir;
}

function run(dir: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--import", join(fixtures, "preload.js"), join("scripts", "move-shopify-tokens.ts")], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GADGET_EXPORT_API_KEY: "test-key",
      SHOPIFY_API_KEY: "client-id-123",
      SHOPIFY_API_SECRET: "hush",
      FAKE_SHOPS: join(dir, "shops.json"),
      FAKE_SESSIONS: join(dir, "sessions.json"),
      FAKE_UPDATE_LOG: join(dir, "updates.log"),
      FAKE_FETCH_LOG: join(dir, "fetches.log"),
      ...env,
    },
  });
}

const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const sessions = (dir: string) => JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8"));
const refused = (shops: string[]) => JSON.stringify(Object.fromEntries(shops.map((shop) => [`${shop}.myshopify.com`, 401])));

after(() => workDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("the token move script in shopify-tokens.md", () => {
  it("saves an expiring pair as the template's offline session, then clears Gadget's refresh token", () => {
    const dir = project([expiring("a")]);
    const result = run(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(sessions(dir)["offline_a.myshopify.com"], {
      id: "offline_a.myshopify.com",
      shop: "a.myshopify.com",
      state: "",
      isOnline: false,
      scope: "read_orders",
      accessToken: "gadget-access-a",
      expires: "2026-11-09T11:00:00.000Z",
      refreshToken: "gadget-refresh-a",
      refreshTokenExpires: "2027-02-07T10:00:00.000Z",
    });
    assert.deepEqual(lines(join(dir, "updates.log")), [{ id: "a", changes: { refreshToken: null } }]);
    // a pair that already expires needs no request to Shopify
    assert.deepEqual(lines(join(dir, "fetches.log")), []);
  });

  it("exchanges a non-expiring token and saves the new pair, with nothing to clear in Gadget", () => {
    const dir = project([nonExpiring("a")]);
    const result = run(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(lines(join(dir, "fetches.log")), [{ shop: "a.myshopify.com", grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", subject_token: "gadget-access-a" }]);
    const session = sessions(dir)["offline_a.myshopify.com"];
    assert.equal(session.accessToken, "new-access-a.myshopify.com");
    assert.equal(session.refreshToken, "new-refresh-a.myshopify.com");
    assert.deepEqual(lines(join(dir, "updates.log")), []);
  });

  it("keeps going when Shopify refuses one store, and lists that store at the end", () => {
    const dir = project([nonExpiring("a"), nonExpiring("b"), nonExpiring("c")]);
    const result = run(dir, { FAKE_TOKEN_STATUS: refused(["b"]) });
    assert.equal(result.status, 0, result.stderr);
    // the stores before and after the refused one both moved
    assert.deepEqual(Object.keys(sessions(dir)).sort(), ["offline_a.myshopify.com", "offline_c.myshopify.com"]);
    assert.match(result.stderr, /failed b\.myshopify\.com: Shopify answered 401/);
    assert.match(result.stdout, /1 stores need their merchant to open the app: b\.myshopify\.com/);
  });

  it("gets past the refused store on every rerun instead of stopping at it", () => {
    const dir = project([nonExpiring("a"), nonExpiring("b"), nonExpiring("c")]);
    run(dir, { FAKE_TOKEN_STATUS: refused(["b", "c"]) });
    assert.deepEqual(Object.keys(sessions(dir)), ["offline_a.myshopify.com"]);

    // c works on the second run. The run must reach it although b, which comes first, is still refused
    const rerun = run(dir, { FAKE_TOKEN_STATUS: refused(["b"]) });
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.deepEqual(Object.keys(sessions(dir)).sort(), ["offline_a.myshopify.com", "offline_c.myshopify.com"]);
    assert.match(rerun.stdout, /skip a\.myshopify\.com: the new app already has a session/);
    assert.match(rerun.stdout, /1 stores need their merchant to open the app: b\.myshopify\.com/);
  });

  it("exits with 1 and names the store when a token request fails with another status, after moving the rest", () => {
    const dir = project([nonExpiring("a"), nonExpiring("b")]);
    const result = run(dir, { FAKE_TOKEN_STATUS: JSON.stringify({ "a.myshopify.com": 429 }) });
    assert.equal(result.status, 1);
    assert.deepEqual(Object.keys(sessions(dir)), ["offline_b.myshopify.com"]);
    assert.match(result.stderr, /failed a\.myshopify\.com: token request for a\.myshopify\.com failed with 429/);
    assert.match(result.stdout, /1 stores failed with another error: a\.myshopify\.com/);
  });

  it("never prints a token", () => {
    const dir = project([expiring("a"), nonExpiring("b"), nonExpiring("c")]);
    const result = run(dir, { FAKE_TOKEN_STATUS: refused(["c"]) });
    assert.doesNotMatch(result.stdout + result.stderr, /gadget-access|gadget-refresh|new-access|new-refresh|hush/);
  });

  it("clears Gadget's refresh token when it skips a store, so a run that died after saving the session leaves one holder", () => {
    const dir = project([expiring("a"), expiring("b")]);
    // the first run dies right after it saves a's session, before it clears Gadget's copy
    const died = run(dir, { FAKE_DIE_AFTER_SESSION: "a.myshopify.com" });
    assert.equal(died.status, 1);
    assert.ok(sessions(dir)["offline_a.myshopify.com"]);
    assert.deepEqual(lines(join(dir, "updates.log")), []);

    const rerun = run(dir);
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.match(rerun.stdout, /skip a\.myshopify\.com/);
    assert.deepEqual(lines(join(dir, "updates.log")), [
      { id: "a", changes: { refreshToken: null } },
      { id: "b", changes: { refreshToken: null } },
    ]);
    // the session saved by the first run is left as it was
    assert.equal(sessions(dir)["offline_a.myshopify.com"].refreshToken, "gadget-refresh-a");
  });

  it("leaves a merchant's fresh session alone, and sends Gadget no update when it has no refresh token to clear", () => {
    const fresh = { id: "offline_a.myshopify.com", shop: "a.myshopify.com", accessToken: "from-token-exchange" };
    const dir = project([nonExpiring("a")], { "offline_a.myshopify.com": fresh });
    const result = run(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(sessions(dir)["offline_a.myshopify.com"], fresh);
    assert.deepEqual(lines(join(dir, "updates.log")), []);
    assert.deepEqual(lines(join(dir, "fetches.log")), []);
  });

  it("lists a store whose refresh token Shopify already rejected, without sending its dead token anywhere", () => {
    const dir = project([{ ...nonExpiring("a"), accessTokenExpiresAt: "2026-11-09T09:00:00.000Z" }]);
    const result = run(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(sessions(dir), {});
    assert.deepEqual(lines(join(dir, "fetches.log")), []);
    assert.match(result.stdout, /1 stores need their merchant to open the app: a\.myshopify\.com/);
  });

  it("moves every store when there are more than one page of them", () => {
    const dir = project(Array.from({ length: 120 }, (_, index) => expiring(`s${index}`)));
    const result = run(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(Object.keys(sessions(dir)).length, 120);
    assert.equal(lines(join(dir, "updates.log")).length, 120);
  });
});
