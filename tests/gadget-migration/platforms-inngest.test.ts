// Run with: node --test "tests/**/*.test.ts"
// The Inngest checks in scripts/checks/inngest.ts, on the fixtures in fixtures/preflight/inngest-*, and on the
// complete examples in references/platforms/inngest.md, which must pass their own checks.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { preflight } from "../../skills/gadget/gadget-migration/scripts/preflight.ts";
import { writeProject } from "./platform-blocks.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/preflight/${name}`, import.meta.url));
const where = (findings: { id: string; file?: string; line?: number }[]) => findings.map((f) => `${f.id} ${f.file ?? ""}${f.line ? `:${f.line}` : ""}`.trim()).sort();
const own = (findings: { id: string }[]) => findings.filter((f) => f.id.startsWith("inngest/"));

const temps: string[] = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function tempApp(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "inngest-app-"));
  temps.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

// the reviewer's CommonJS app: the functions array is exported with module.exports and served by inngest/express
function commonJsApp(served: string) {
  return tempApp({
    "package.json": JSON.stringify({ type: "commonjs", dependencies: { inngest: "4.26.2", express: "5.1.0" } }),
    "src/inngest.js": [
      'const { Inngest } = require("inngest");',
      'const inngest = new Inngest({ id: "my-app", checkpointing: { maxRuntime: "4m" } });',
      "const notifyExternalSystem = inngest.createFunction(",
      '  { id: "notify-external-system", triggers: [{ event: "app/order.created" }] },',
      '  async ({ event, step }) => { await step.run("notify", () => fetch("https://example.com/" + event.data.orderId)); }',
      ");",
      `module.exports = { inngest, functions: [${served}] };`,
    ].join("\n"),
    "src/server.js": 'const express = require("express");\nconst { serve } = require("inngest/express");\nconst { inngest, functions } = require("./inngest");\nconst app = express();\napp.use("/api/inngest", serve({ client: inngest, functions }));\napp.listen(3000);\n',
  });
}

const bigints = (code: string) =>
  where(own(preflight(tempApp({ "package.json": JSON.stringify({ dependencies: { inngest: "4.26.2" } }), "app/inngest.server.ts": 'import { Inngest } from "inngest";\nexport const inngest = new Inngest({ id: "a", checkpointing: { maxRuntime: "4m" } });\n', "app/send.ts": code }), ["inngest"]).findings).filter((f) => f.id === "inngest/bigint-in-send"));

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

  it("finds the serve() of a CommonJS app that requires inngest/express", () => {
    assert.deepEqual(where(own(preflight(commonJsApp("notifyExternalSystem"), ["inngest"]).findings)), []);
    // and still reports a function the exported array leaves out
    assert.deepEqual(where(own(preflight(commonJsApp(""), ["inngest"]).findings)), ["inngest/function-not-served src/inngest.js:3"]);
  });

  it("types a name by the nearest declaration in scope, not by a property or another function's parameter", () => {
    // a string const after a bigint property type, and a parameter of another function
    assert.deepEqual(bigints('import { inngest } from "./inngest.server";\nexport async function a(shopId: bigint) {}\nexport async function b(session: { shopId: bigint }) {\n  const shopId = String(session.shopId);\n  const orderId = `${session.shopId}`;\n  await inngest.send({ name: "x", data: { shopId, orderId } });\n}\n'), []);
    // a bigint parameter, a copy of it, and a const made with BigInt() still count
    assert.deepEqual(bigints('import { inngest } from "./inngest.server";\nexport async function a(shopId: bigint, n: string) {\n  const id = shopId;\n  const big = BigInt(n);\n  await inngest.send({ name: "x", data: { shopId, id, big } });\n}\n'), [
      "inngest/bigint-in-send app/send.ts:5",
      "inngest/bigint-in-send app/send.ts:5",
      "inngest/bigint-in-send app/send.ts:5",
    ]);
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
