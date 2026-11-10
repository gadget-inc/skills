// Run with: node --test "tests/**/*.test.ts"
// The Inngest checks in scripts/checks/inngest.ts, on the fixtures in fixtures/preflight/inngest-*, and on the
// complete examples in references/platforms/inngest.md, which must pass their own checks.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { preflight } from "../../skills/gadget/gadget-migration/scripts/preflight.ts";
import { writeProject } from "./platform-blocks.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/preflight/${name}`, import.meta.url));
const where = (findings: { id: string; file?: string; line?: number }[]) => findings.map((f) => `${f.id} ${f.file ?? ""}${f.line ? `:${f.line}` : ""}`.trim()).sort();
const own = (findings: { id: string }[]) => findings.filter((f) => f.id.startsWith("inngest/"));

describe("Inngest checks", () => {
  it("finds each pitfall in the bad fixture, at its line", () => {
    const { findings } = preflight(fixture("inngest-bad"), ["inngest"]);
    assert.deepEqual(where(own(findings)), [
      "inngest/account-scope app/inngest.server.ts:24",
      "inngest/bigint-in-send app/services/orders.server.ts:9",
      "inngest/cron-overlap app/inngest.server.ts:30",
      "inngest/cron-synced-early app/inngest.server.ts:30",
      "inngest/dev-flag-in-config Dockerfile:6",
      "inngest/function-not-served app/inngest.server.ts:23",
      "inngest/key-field-missing app/services/orders.server.ts:15",
      "inngest/large-payload app/routes/webhooks.orders.create.tsx:9",
      "inngest/max-runtime app/inngest.server.ts:7",
      "inngest/negative-priority app/inngest.server.ts:14",
      "inngest/send-in-transaction app/services/orders.server.ts:7",
      "inngest/work-outside-step app/inngest.server.ts:18",
    ]);
    const bySeverity = Object.fromEntries(own(findings).map((f) => [f.id, f.severity]));
    assert.equal(bySeverity["inngest/function-not-served"], "error");
    assert.equal(bySeverity["inngest/cron-synced-early"], "manual");
    assert.equal(bySeverity["inngest/work-outside-step"], "warning");
    for (const f of own(findings)) {
      assert.ok(f.fix.endsWith("."), `${f.id} fix ends with a period`);
      assert.match(f.docs ?? "", /^https:\/\/docs\.gadget\.dev\/guides\/moving-to-another-platform\/inngest#/);
    }
  });

  it("finds nothing in the good fixture, which fixes each one", () => {
    assert.deepEqual(where(own(preflight(fixture("inngest-good"), ["inngest"]).findings)), []);
  });

  it("is detected from package.json", () => {
    assert.ok(preflight(fixture("inngest-bad")).platforms.some((p) => p.platform === "inngest"));
  });

  it("reports every function as not served when nothing calls serve()", () => {
    const dir = mkdtempSync(join(tmpdir(), "inngest-noserve-"));
    try {
      writeProject("inngest.md", dir);
      const ids = where(own(preflight(dir, ["inngest"]).findings));
      assert.deepEqual(ids.filter((id) => id.startsWith("inngest/function-not-served")).length, 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes the complete examples in references/platforms/inngest.md, served by the guide's route", () => {
    const dir = mkdtempSync(join(tmpdir(), "inngest-reference-"));
    try {
      writeProject("inngest.md", dir, {
        "app/routes/api.inngest.ts": 'import { serve } from "inngest/remix";\nimport { functions, inngest } from "../inngest.server";\nconst handler = serve({ client: inngest, functions });\nexport { handler as action, handler as loader };\n',
      });
      assert.deepEqual(where(own(preflight(dir, ["inngest"]).findings)), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
