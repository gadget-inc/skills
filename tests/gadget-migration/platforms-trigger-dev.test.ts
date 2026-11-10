// Run with: node --test "tests/**/*.test.ts"
// The Trigger.dev checks in scripts/checks/trigger-dev.ts, on the fixtures in fixtures/preflight/trigger-dev-*, and on
// the complete examples in references/platforms/trigger-dev.md, which must pass their own checks.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { preflight } from "../../skills/gadget/gadget-migration/scripts/preflight.ts";
import { writeProject } from "./platform-blocks.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/preflight/${name}`, import.meta.url));
const where = (findings: { id: string; file?: string; line?: number }[]) => findings.map((f) => `${f.id} ${f.file ?? ""}${f.line ? `:${f.line}` : ""}`.trim()).sort();
const own = (findings: { id: string }[]) => findings.filter((f) => f.id.startsWith("trigger-dev/"));

const temps: string[] = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
// a copy of trigger-dev-good with its versions and scripts changed, and extra files written
function variant(change: (pkg: any) => void, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "trigger-dev-variant-"));
  temps.push(dir);
  cpSync(fixture("trigger-dev-good"), dir, { recursive: true });
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  change(pkg);
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
const sdk = (range: string) => (pkg: any) => {
  pkg.dependencies["@trigger.dev/sdk"] = range;
  pkg.devDependencies["@trigger.dev/build"] = range;
};
const ids = (dir: string, id: string) => own(preflight(dir, ["trigger-dev"]).findings).filter((f) => f.id === id);

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

  it("reads the SDK version the lockfile installs, so ^4.6.0 that installed 4.8.3 passes", () => {
    const npm = (version: string) => JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/@trigger.dev/sdk": { version } } });
    assert.deepEqual(ids(variant(sdk("^4.6.0"), { "package-lock.json": npm("4.8.3") }), "trigger-dev/sdk-version"), []);
    const old = ids(variant(sdk("^4.6.0"), { "package-lock.json": npm("4.6.2") }), "trigger-dev/sdk-version");
    // one per task with a concurrency option
    assert.ok(old.length > 0 && old.every((f) => f.severity === "error"));
    assert.match(old[0].message, /package-lock\.json installs 4\.6\.2/);
    const pnpm = "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      '@trigger.dev/sdk':\n        specifier: ^4.6.0\n        version: 4.6.1(typescript@5.9.3)\n";
    assert.match(ids(variant(sdk("^4.6.0"), { "pnpm-lock.yaml": pnpm }), "trigger-dev/sdk-version")[0]?.message ?? "", /pnpm-lock\.yaml installs 4\.6\.1/);
    const yarn = '"@trigger.dev/sdk@^4.6.0":\n  version "4.8.3"\n  resolved "https://registry.yarnpkg.com/@trigger.dev/sdk/-/sdk-4.8.3.tgz"\n';
    assert.deepEqual(ids(variant(sdk("^4.6.0"), { "yarn.lock": yarn }), "trigger-dev/sdk-version"), []);
  });

  it("with no lockfile, reports an exact pin or a range below 4.7.0, and not a range that installs 4.7 or later", () => {
    assert.deepEqual(ids(variant(sdk("^4.6.0")), "trigger-dev/sdk-version"), []);
    assert.match(ids(variant(sdk("~4.6.0")), "trigger-dev/sdk-version")[0]?.message ?? "", /~4\.6\.0 only allows versions below 4\.7\.0/);
    assert.match(ids(variant(sdk("4.6.0")), "trigger-dev/sdk-version")[0]?.message ?? "", /package\.json pins 4\.6\.0/);
  });

  it("reports trigger.dev@latest as an error only where it deploys", () => {
    const latest = (scripts: Record<string, string>, files: Record<string, string> = {}) =>
      ids(variant((pkg) => Object.assign(pkg.scripts, scripts), files), "trigger-dev/cli-latest").map((f) => `${f.severity} ${f.file}:${f.line}`);
    // the guide's dev command
    assert.deepEqual(latest({ "dev:trigger": "npx trigger.dev@latest dev" }), []);
    assert.deepEqual(latest({ "deploy:trigger": "npx trigger.dev@latest deploy" }), ["error package.json:6"]);
    // no command the script can read: whatever runs it may add deploy
    assert.deepEqual(latest({ trigger: "npx trigger.dev@latest" }), ["warning package.json:8"]);
    // a CI workflow that installs the latest CLI and deploys with it
    const workflow = "jobs:\n  deploy:\n    steps:\n      - run: npm install -g trigger.dev@latest\n      - run: trigger.dev deploy\n";
    assert.deepEqual(latest({}, { ".github/workflows/trigger.yml": workflow }), ["error .github/workflows/trigger.yml:4"]);
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
