// Run with: node --test "tests/**/*.test.ts"
// The Trigger.dev checks in scripts/checks/trigger-dev.ts, on the fixtures in fixtures/preflight/trigger-dev-*, and on
// the complete examples in references/platforms/trigger-dev.md, which must pass their own checks.
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
const own = (findings: { id: string }[]) => findings.filter((f) => f.id.startsWith("trigger-dev/"));

describe("Trigger.dev checks", () => {
  it("finds each pitfall in the bad fixture, at its line", () => {
    const { findings } = preflight(fixture("trigger-dev-bad"), ["trigger-dev"]);
    assert.deepEqual(where(own(findings)), [
      "trigger-dev/cli-latest package.json:6",
      "trigger-dev/db-client-in-run app/trigger/notify-external-system.ts:9",
      "trigger-dev/default-retries trigger.config.ts:3",
      "trigger-dev/env-vars trigger.config.ts:3",
      "trigger-dev/idempotency-ttl app/services/orders.server.ts:11",
      "trigger-dev/max-duration trigger.config.ts:3",
      "trigger-dev/named-limit app/trigger/limits.ts:3",
      "trigger-dev/negative-priority app/services/orders.server.ts:19",
      "trigger-dev/on-failure-gaps app/trigger/notify-external-system.ts:13",
      "trigger-dev/perkey-without-key app/services/orders.server.ts:8",
      "trigger-dev/priority-mixed app/services/orders.server.ts:8",
      "trigger-dev/prisma-extension trigger.config.ts:3",
      "trigger-dev/schedule-deployed-early app/trigger/prune-audit-logs.ts:6",
      "trigger-dev/schedule-overlap app/trigger/prune-audit-logs.ts:4",
      "trigger-dev/schedule-window app/trigger/prune-audit-logs.ts:6",
      "trigger-dev/sdk-version app/trigger/notify-external-system.ts:20",
      "trigger-dev/sdk-version app/trigger/notify-external-system.ts:28",
      "trigger-dev/sdk-version app/trigger/notify-external-system.ts:7",
      "trigger-dev/trigger-in-transaction app/services/orders.server.ts:8",
      "trigger-dev/ttl-shorter-than-delay app/services/orders.server.ts:22",
      "trigger-dev/version-mismatch package.json:10",
    ]);
    const env = own(findings).find((f) => f.id === "trigger-dev/env-vars")!;
    assert.equal(env.severity, "manual");
    assert.match(env.message, /Your tasks read EXTERNAL_API_TOKEN\./);
    const latest = own(findings).find((f) => f.id === "trigger-dev/cli-latest")!;
    assert.equal(latest.error, "ERROR: Version mismatch detected while running in CI. This won't end well. Aborting.");
    for (const f of own(findings)) {
      assert.ok(f.fix.endsWith("."), `${f.id} fix ends with a period`);
      assert.match(f.docs ?? "", /^https:\/\/docs\.gadget\.dev\/guides\/moving-to-another-platform\/trigger-dev#/);
    }
  });

  it("finds nothing in the good fixture, which fixes each one", () => {
    assert.deepEqual(where(own(preflight(fixture("trigger-dev-good"), ["trigger-dev"]).findings)), []);
  });

  it("is detected from trigger.config.ts or the SDK", () => {
    assert.ok(preflight(fixture("trigger-dev-good")).platforms.some((p) => p.platform === "trigger-dev"));
  });

  it("passes the complete examples in references/platforms/trigger-dev.md, apart from the onFailure reminder", () => {
    const dir = mkdtempSync(join(tmpdir(), "trigger-dev-reference-"));
    try {
      writeProject("trigger-dev.md", dir, {
        "app/trigger/queues.ts": 'import { queue } from "@trigger.dev/sdk";\nexport const externalQueue = queue({ name: "external", concurrencyLimit: 2 });\n',
      });
      assert.deepEqual(own(preflight(dir, ["trigger-dev"]).findings).map((f) => `${f.id} ${f.file}`), ["trigger-dev/on-failure-gaps app/trigger/notify-external-system.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
