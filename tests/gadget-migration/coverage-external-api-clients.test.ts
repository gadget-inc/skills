// Run with: node --test "tests/**/*.test.ts"
// Imports the API key code block from references/external-api-clients.md and checks it against
// hashes computed independently with node:crypto.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { blocks, importBlock } from "./coverage-snippets.ts";

const { createApiKey, roleForApiKey } = await importBlock(blocks("external-api-clients.md", "app/services/api-keys.server.ts")[0]);
const hashOf = (key: string) => createHash("sha256").update(key).digest("hex");

describe("API keys in external-api-clients.md", () => {
  it("creates distinct keys and stores only their SHA-256", async () => {
    const first = await createApiKey();
    const second = await createApiKey();
    assert.match(first.key, /^sk_[0-9a-f]{48}$/);
    assert.notEqual(first.key, second.key);
    assert.equal(first.hash, hashOf(first.key));
    assert.ok(!first.hash.includes(first.key.slice(3)));
  });

  it("returns the role of the matching key, wherever it sits in the map", async () => {
    const reporting = await createApiKey();
    const warehouse = await createApiKey();
    const stored = new Map([
      [reporting.hash, "reporting"],
      [warehouse.hash, "warehouse"],
    ]);
    assert.equal(await roleForApiKey(`Bearer ${reporting.key}`, stored), "reporting");
    assert.equal(await roleForApiKey(`Bearer ${warehouse.key}`, stored), "warehouse");
  });

  it("returns null for a wrong key, a near miss, and a malformed header", async () => {
    const { key, hash } = await createApiKey();
    const stored = new Map([[hash, "reporting"]]);
    const nearMiss = key.slice(0, -1) + (key.endsWith("0") ? "1" : "0");
    for (const header of [null, "", key, `Basic ${key}`, `Bearer ${nearMiss}`, `Bearer ${key} extra`, "Bearer ", `Bearer ${hash}`]) {
      assert.equal(await roleForApiKey(header, stored), null, `accepted ${header}`);
    }
  });

  it("does not match a stored value that is not a full hash", async () => {
    const { key, hash } = await createApiKey();
    assert.equal(await roleForApiKey(`Bearer ${key}`, new Map([[hash.slice(0, 32), "truncated"]])), null);
    assert.equal(await roleForApiKey(`Bearer ${key}`, new Map([["", "empty"]])), null);
  });
});
