// Run with: node --test "tests/**/*.test.ts"
// The Render checks in scripts/checks/render.ts against fixtures/preflight/render-bad and render-good,
// and the Blueprint in references/platforms/render.md against the same checks.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { preflight } from "../../skills/gadget/gadget-migration/scripts/preflight.ts";
import { block } from "./platform-blocks.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/preflight/${name}`, import.meta.url));
const renderFindings = (dir: string) => preflight(dir, ["render"]).findings.filter((f) => f.id.startsWith("render/"));
const where = (f: { id: string; file?: string; line?: number }) => `${f.id} ${f.file}:${f.line}`;

const temps: string[] = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function copyOf(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "render-preflight-"));
  temps.push(dir);
  cpSync(fixture(name), dir, { recursive: true });
  return dir;
}

describe("Render checks on render-bad", () => {
  const findings = renderFindings(fixture("render-bad"));
  const expected: [string, "error" | "warning" | "manual", string, number][] = [
    ["render/keyvalue-eviction", "error", "render.yaml", 48],
    ["render/keyvalue-persistence", "error", "render.yaml", 51],
    // no dockerCommand: runs the Dockerfile's CMD, the web server
    ["render/worker-command", "error", "render.yaml", 27],
    // pnpm
    ["render/worker-command", "error", "render.yaml", 36],
    ["render/shutdown-delay", "error", "render.yaml", 31],
    ["render/shutdown-delay", "manual", "render.yaml", 32],
    ["render/migrate-on-start", "warning", "render.yaml", 41],
    ["render/no-migrations", "warning", "render.yaml", 8],
    ["render/prisma-generate", "error", "render.yaml", 8],
    ["render/health-check", "warning", "render.yaml", 3],
    ["render/single-instance", "warning", "render.yaml", 3],
    ["render/open-to-internet", "warning", "render.yaml", 56],
    ["render/open-to-internet", "warning", "render.yaml", 52],
    ["render/migrations-through-pool", "error", "render.yaml", 20],
    ["render/owner-skips-rls", "error", "prisma/migrations/20261101000000_init/migration.sql", 4],
    ["render/env-group-secret", "error", "render.yaml", 63],
    ["render/env-group-reference", "error", "render.yaml", 65],
    ["render/cron-job", "manual", "render.yaml", 42],
    ["render/free-plan", "warning", "render.yaml", 7],
    ["render/free-plan", "warning", "render.yaml", 58],
    ["render/region", "error", "render.yaml", 22],
    ["render/disk", "warning", "render.yaml", 9],
    ["render/workflows-start", "warning", "app/services/start-reconciliation.server.ts", 8],
  ];

  for (const [id, severity, file, line] of expected) {
    it(`reports ${id} at ${file}:${line}`, () => {
      const found = findings.find((f) => f.id === id && f.file === file && f.line === line);
      assert.ok(found, `missing ${id} at ${file}:${line}; got:\n${findings.map(where).join("\n")}`);
      assert.equal(found.severity, severity);
      assert.ok(found.fix.length > 0 && found.message.length > 0);
      assert.match(found.docs ?? "", /^https:\/\/docs\.gadget\.dev\/guides\/moving-to-another-platform/);
    });
  }

  it("reports nothing else", () => {
    assert.equal(findings.length, expected.length, findings.map(where).join("\n"));
  });

  it("gives the error text a reader will see", () => {
    const text = (id: string) => findings.find((f) => f.id === id)?.error;
    assert.equal(text("render/keyvalue-eviction"), 'IMPORTANT! Eviction policy is allkeys-lru. It should be "noeviction"');
    assert.match(text("render/migrations-through-pool") ?? "", /pg_advisory_lock\(72707369\)/);
    assert.equal(text("render/no-migrations"), "The table `public.Session` does not exist in the current database.");
    assert.equal(text("render/prisma-generate"), "@prisma/client did not initialize yet");
  });
});

describe("Render checks on render-good", () => {
  it("reports nothing", () => {
    const findings = renderFindings(fixture("render-good"));
    assert.deepEqual(findings.map(where), []);
  });
});

describe("the Blueprint in render.md", () => {
  it("passes the Render checks, apart from the reminder about its cron job", () => {
    const dir = copyOf("render-good");
    writeFileSync(join(dir, "render.yaml"), block("render.md", "render.yaml"));
    const findings = renderFindings(dir);
    assert.deepEqual(findings.map((f) => `${f.severity} ${f.id}`), ["manual render/cron-job"]);
  });
});

describe("the Workflows start worker in render.md", () => {
  it("isn't reported for SIGTERM, because it returns the worker to the code that starts it", () => {
    const dir = copyOf("render-good");
    mkdirSync(join(dir, "app/jobs"), { recursive: true });
    writeFileSync(join(dir, "app/jobs/reconcile-all-shops.server.ts"), block("render.md", "app/jobs/reconcile-all-shops.server.ts"));
    const ids = preflight(dir, ["render"]).findings.map((f) => f.id);
    assert.ok(!ids.includes("common/worker-sigterm"), ids.join(", "));
    assert.ok(!ids.includes("render/workflows-start"), ids.join(", "));
  });
});

describe("a service with dockerfilePath", () => {
  const template = 'FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nRUN npm run build\nCMD ["npm", "run", "docker-start"]\n';
  const withService = (dir: string, path: string) => {
    const yaml = readFileSync(join(dir, "render.yaml"), "utf8").replace("    dockerCommand: npm run start\n", `    dockerCommand: npm run start\n    dockerfilePath: ${path}\n`);
    writeFileSync(join(dir, "render.yaml"), yaml);
  };

  it("reads that Dockerfile for prisma generate, not the root one", () => {
    const dir = copyOf("render-good");
    writeFileSync(join(dir, "Dockerfile.render"), readFileSync(join(dir, "Dockerfile"), "utf8"));
    writeFileSync(join(dir, "Dockerfile"), template);
    withService(dir, "./Dockerfile.render");
    assert.deepEqual(renderFindings(dir).map(where), []);
  });

  it("reports prisma-generate when that Dockerfile skips it, even though the root one runs it", () => {
    const dir = copyOf("render-good");
    writeFileSync(join(dir, "Dockerfile.render"), template);
    withService(dir, "Dockerfile.render");
    const found = renderFindings(dir);
    assert.deepEqual(found.map(where), ["render/prisma-generate render.yaml:10"]);
    assert.match(found[0].message, /nothing in Dockerfile\.render runs prisma generate/);
  });
});

describe("a render.yaml the script can't read", () => {
  it("asks for a check by hand instead of passing", () => {
    const dir = copyOf("render-good");
    writeFileSync(join(dir, "render.yaml"), "services:\n  - type: web\n   name: misaligned\n");
    const findings = renderFindings(dir);
    assert.deepEqual(findings.map((f) => `${f.severity} ${f.id}`), ["manual render/blueprint-unreadable"]);
  });
});
