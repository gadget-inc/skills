// Run with: node --test "tests/**/*.test.ts"
// The Hookdeck checks in scripts/checks/hookdeck.ts, on the fixtures in fixtures/preflight/hookdeck-*, and on the
// complete examples in references/platforms/hookdeck.md, which must pass their own checks.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { preflight } from "../../skills/gadget/gadget-migration/scripts/preflight.ts";
import { writeProject } from "./platform-blocks.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/preflight/${name}`, import.meta.url));
const where = (findings: { id: string; file?: string; line?: number }[]) => findings.map((f) => `${f.id} ${f.file ?? ""}${f.line ? `:${f.line}` : ""}`.trim()).sort();
const own = (findings: { id: string }[]) => findings.filter((f) => f.id.startsWith("hookdeck/"));

const temps: string[] = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
// a copy of hookdeck-good with some files replaced, and others removed when their text is null
function variant(files: Record<string, string | null>): string {
  const dir = mkdtempSync(join(tmpdir(), "hookdeck-variant-"));
  temps.push(dir);
  cpSync(fixture("hookdeck-good"), dir, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    if (text === null) rmSync(join(dir, path), { force: true });
    else {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  }
  return dir;
}
const toml = (uris: string[]) => ['client_id = "abc123"', "", "[webhooks]", 'api_version = "2026-04"', ...uris.flatMap((uri, i) => ["", "  [[webhooks.subscriptions]]", `  topics = ["topic/${i}"]`, `  uri = "${uri}"`])].join("\n") + "\n";
const setup = (url: string) => `#!/bin/sh\nhookdeck gateway connection upsert shopify-to-new-app \\\n  --source-type SHOPIFY \\\n  --destination-url ${url} \\\n  --rules '[{ "type": "retry", "count": 10 }]'\n`;
// one route that handles every topic, as the reviewer's single-endpoint app has
const singleRoute = 'import { authenticate } from "../shopify.server";\nimport { hasHookdeckSignature } from "../hookdeck.server";\n\n// Shopify\'s HMAC covers the raw bytes, so never call request.json() before authenticate.webhook.\nexport const action = async ({ request }) => {\n  if (!hasHookdeckSignature(request, await request.clone().text())) return new Response(undefined, { status: 401 });\n  const { topic } = await authenticate.webhook(request);\n  return new Response(topic);\n};\n';
const paths = (dir: string) => where(own(preflight(dir, ["hookdeck"]).findings).filter((f) => f.id === "hookdeck/destination-path" || f.id === "hookdeck/toml-uri"));

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

  it("ignores request.json() in a comment above the HMAC check", () => {
    const found = own(preflight(fixture("hookdeck-good"), ["hookdeck"]).findings);
    assert.ok(!found.some((f) => f.id === "hookdeck/body-before-hmac"));
  });

  it("accepts one route for every topic: bare source URLs in the toml and the path in the destination URL", () => {
    const dir = variant({
      "shopify.app.toml": toml(["https://hkdk.events/src_abc123", "https://hkdk.events/src_abc123"]),
      "scripts/setup-hookdeck.sh": setup("https://app.example.com/webhooks"),
      "app/routes/webhooks.orders.updated.tsx": null,
      "app/routes/webhooks.tsx": singleRoute,
    });
    assert.deepEqual(where(own(preflight(dir, ["hookdeck"]).findings)), ["hookdeck/connection-audit shopify.app.toml:8"]);
  });

  it("reports a path in both the URI and the destination URL, which Hookdeck doubles", () => {
    const dir = variant({ "scripts/setup-hookdeck.sh": setup("https://app.example.com/webhooks") });
    const found = own(preflight(dir, ["hookdeck"]).findings).filter((f) => f.id === "hookdeck/destination-path");
    assert.deepEqual(found.map((f) => `${f.severity} ${f.file}:${f.line}`), ["error scripts/setup-hookdeck.sh:4"]);
    assert.match(found[0].message, /arrives at \/webhooks\/webhooks\/orders\/updated/);
  });

  it("reports bare source URLs with an origin-only destination, which delivers every topic to /", () => {
    const dir = variant({ "shopify.app.toml": toml(["https://hkdk.events/src_abc123", "https://hkdk.events/src_abc123"]) });
    assert.deepEqual(paths(dir), ["hookdeck/toml-uri shopify.app.toml:12", "hookdeck/toml-uri shopify.app.toml:8"]);
    assert.ok(own(preflight(dir, ["hookdeck"]).findings).filter((f) => f.id === "hookdeck/toml-uri").every((f) => f.severity === "error"));
  });

  it("with no destination in the repository, errors on bare source URLs only when several routes need them", () => {
    const bare = toml(["https://hkdk.events/src_abc123"]);
    const several = variant({ "shopify.app.toml": bare, "scripts/setup-hookdeck.sh": null, "app/routes/webhooks.app.uninstalled.tsx": singleRoute });
    assert.deepEqual(own(preflight(several, ["hookdeck"]).findings).filter((f) => f.id === "hookdeck/toml-uri").map((f) => f.severity), ["error"]);
    const one = variant({ "shopify.app.toml": bare, "scripts/setup-hookdeck.sh": null });
    assert.deepEqual(own(preflight(one, ["hookdeck"]).findings).filter((f) => f.id === "hookdeck/toml-uri").map((f) => f.severity), ["warning"]);
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
