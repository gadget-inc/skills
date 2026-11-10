// Run with: node --test "tests/**/*.test.ts"
// The Hookdeck checks in scripts/checks/hookdeck.ts, on the fixtures in fixtures/preflight/hookdeck-*, and on the
// complete examples in references/platforms/hookdeck.md, which must pass their own checks.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { preflight } from "../../skills/gadget/gadget-migration/scripts/preflight.ts";
import { writeProject } from "./platform-blocks.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/preflight/${name}`, import.meta.url));
const where = (findings: { id: string; file?: string; line?: number }[]) => findings.map((f) => `${f.id} ${f.file ?? ""}${f.line ? `:${f.line}` : ""}`.trim()).sort();
const own = (findings: { id: string }[]) => findings.filter((f) => f.id.startsWith("hookdeck/"));

describe("Hookdeck checks", () => {
  it("finds each pitfall in the bad fixture, at its line", () => {
    const { findings } = preflight(fixture("hookdeck-bad"), ["hookdeck"]);
    assert.deepEqual(where(own(findings)), [
      "hookdeck/body-before-hmac app/routes/webhooks.orders.updated.tsx:6",
      "hookdeck/connection-audit shopify.app.toml:10",
      "hookdeck/dedupe-window-seconds scripts/rules.json:3",
      "hookdeck/dedupe-window-seconds scripts/setup-hookdeck.sh:10",
      "hookdeck/destination-path scripts/setup-hookdeck.sh:7",
      "hookdeck/filter-replaces-rules scripts/setup-hookdeck.sh:12",
      "hookdeck/filter-syntax scripts/rules.json:5",
      "hookdeck/filter-syntax scripts/setup-hookdeck.sh:13",
      "hookdeck/hand-written-filter scripts/rules.json:5",
      "hookdeck/hand-written-filter scripts/setup-hookdeck.sh:13",
      "hookdeck/no-hookdeck-signature app/routes/webhooks.orders.updated.tsx:7",
      "hookdeck/processed-webhook db/processed_webhook.sql:1",
      "hookdeck/retry-5xx-only scripts/setup-hookdeck.sh:9",
      "hookdeck/source-webhook-secret scripts/setup-hookdeck.sh:5",
      "hookdeck/toml-uri shopify.app.toml:10",
      "hookdeck/toml-uri shopify.app.toml:14",
      "hookdeck/transform-rule scripts/rules.json:4",
    ]);
    const byId = new Map(own(findings).map((f) => [f.id, f]));
    assert.equal(byId.get("hookdeck/body-before-hmac")!.error, "TypeError: Body is unusable: Body has already been read");
    assert.match(byId.get("hookdeck/destination-path")!.message, /arrives at \/webhooks\/orders\/updated\/webhooks\/orders\/updated/);
    assert.match(byId.get("hookdeck/dedupe-window-seconds")!.message, /3\.6 seconds/);
    assert.equal(byId.get("hookdeck/connection-audit")!.severity, "manual");
    for (const f of own(findings)) {
      assert.ok(f.fix.endsWith("."), `${f.id} fix ends with a period`);
      assert.match(f.docs ?? "", /^https:\/\/docs\.gadget\.dev\/guides\/moving-to-another-platform\/hookdeck#/);
    }
  });

  it("leaves only the reminder to audit the connections in the good fixture", () => {
    assert.deepEqual(where(own(preflight(fixture("hookdeck-good"), ["hookdeck"]).findings)), ["hookdeck/connection-audit shopify.app.toml:10"]);
  });

  it("asks for a processed_webhook table when there is none", () => {
    const dir = mkdtempSync(join(tmpdir(), "hookdeck-no-table-"));
    try {
      cpSync(fixture("hookdeck-good"), dir, { recursive: true });
      rmSync(join(dir, "db"), { recursive: true });
      const found = own(preflight(dir, ["hookdeck"]).findings).filter((f) => f.id === "hookdeck/processed-webhook");
      assert.equal(found.length, 1);
      assert.equal(found[0].file, "shopify.app.toml");
      assert.match(found[0].message, /nothing records which webhook ids the app processed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is detected from hkdk.events in shopify.app.toml or x-hookdeck-signature in code", () => {
    assert.ok(preflight(fixture("hookdeck-bad")).platforms.some((p) => p.platform === "hookdeck"));
    assert.ok(preflight(fixture("hookdeck-good")).platforms.some((p) => p.platform === "hookdeck"));
    assert.ok(!preflight(fixture("inngest-good")).platforms.some((p) => p.platform === "hookdeck"));
  });

  it("passes the complete examples in references/platforms/hookdeck.md", () => {
    const dir = mkdtempSync(join(tmpdir(), "hookdeck-reference-"));
    try {
      writeProject("hookdeck.md", dir);
      assert.deepEqual(where(own(preflight(dir, ["hookdeck"]).findings)), ["hookdeck/connection-audit"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
