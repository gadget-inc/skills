// Run with: node --test "tests/**/*.test.ts"
// The Railway checks in scripts/checks/railway.ts against fixtures/preflight/railway-bad and railway-good,
// and the project file in references/platforms/railway.md against the same checks.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { preflight } from "../../skills/gadget/gadget-migration/scripts/preflight.ts";
import { arithmetic, minutesBetweenRuns } from "../../skills/gadget/gadget-migration/scripts/checks/railway.ts";
import { block } from "./platform-blocks.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/preflight/${name}`, import.meta.url));
const railwayFindings = (dir: string) => preflight(dir, ["railway"]).findings.filter((f) => f.id.startsWith("railway/"));
const where = (f: { id: string; severity: string; file?: string; line?: number }) => `${f.severity} ${f.id} ${f.file}:${f.line}`;
const IAC = ".railway/railway.ts";

const temps: string[] = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function copyOf(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "railway-preflight-"));
  temps.push(dir);
  cpSync(fixture(name), dir, { recursive: true });
  return dir;
}

describe("Railway checks on railway-bad", () => {
  const findings = railwayFindings(fixture("railway-bad"));
  const expected: [string, "error" | "warning" | "manual", string, number | undefined][] = [
    // web: no drainingSeconds, no health check, Serverless on
    ["railway/draining", "warning", IAC, 17],
    ["railway/health-check", "warning", IAC, 17],
    ["railway/serverless", "error", IAC, 21],
    ["railway/prisma-generate", "error", IAC, 19],
    // worker: pnpm and no drainingSeconds
    ["railway/draining", "warning", IAC, 25],
    ["railway/pnpm-start", "error", IAC, 27],
    ["railway/migrate-on-start", "warning", IAC, 33],
    ["railway/cron-interval", "error", IAC, 41],
    ["railway/cron-before-cutover", "manual", IAC, 38],
    ["railway/superuser-url", "error", IAC, 9],
    ["railway/direct-url-pooler", "manual", IAC, 10],
    ["railway/private-domain-url", "manual", IAC, 11],
    // ${{Redis.REDIS_URL}}: a Redis added from the dashboard, which apply would delete
    ["railway/unknown-reference", "warning", IAC, 12],
    ["railway/unknown-reference", "warning", IAC, 42],
    ["railway/public-domain-scheme", "error", IAC, 13],
    ["railway/config-apply", "manual", IAC, undefined],
    ["railway/config-as-code", "warning", "railway.json", 3],
    ["railway/redis-persistence", "manual", undefined as unknown as string, undefined],
    ["railway/ioredis-family", "warning", "app/queues.server.ts", 4],
    ["railway/bucket-name", "error", "app/services/bucket.server.ts", 8],
    ["railway/presign-expiry", "error", "app/services/bucket.server.ts", 9],
    ["railway/smtp", "manual", "package.json", undefined],
  ];

  for (const [id, severity, file, line] of expected) {
    it(`reports ${id} at ${file ?? "(no file)"}:${line ?? ""}`, () => {
      const found = findings.find((f) => f.id === id && f.file === file && f.line === line);
      assert.ok(found, `missing ${id} at ${file}:${line}; got:\n${findings.map(where).join("\n")}`);
      assert.equal(found.severity, severity);
      assert.ok(found.fix.length > 0 && found.message.length > 0);
      assert.match(found.docs ?? "", /^https:\/\/docs\.gadget\.dev\/guides\/moving-to-another-platform\/railway/);
    });
  }

  it("reports nothing else", () => {
    assert.equal(findings.length, expected.length, findings.map(where).join("\n"));
  });

  it("gives the error text a reader will see", () => {
    const text = (id: string) => findings.find((f) => f.id === id)?.error;
    assert.equal(text("railway/presign-expiry"), "Signature version 4 presigned URLs must have an expiration date less than one week in the future");
    assert.equal(text("railway/public-domain-scheme"), "TypeError: Invalid URL");
    assert.match(text("railway/direct-url-pooler") ?? "", /pg_advisory_lock\(72707369\)/);
    assert.match(findings.find((f) => f.id === "railway/unknown-reference")!.message, /deletes every resource the file leaves out/);
    assert.match(findings.find((f) => f.id === "railway/config-as-code")!.message, /startCommand, drainingSeconds/);
  });
});

describe("Railway checks on railway-good", () => {
  it("leaves only the reminders that hold for every project file", () => {
    const findings = railwayFindings(fixture("railway-good"));
    // the hand-built app_user URL needs its host changed once PgBouncer or high availability is on
    assert.deepEqual(findings.map(where), [`manual railway/private-domain-url ${IAC}:10`, `manual railway/config-apply ${IAC}:undefined`]);
  });
});

describe("the project file in railway.md", () => {
  it("passes the Railway checks, apart from the reminders", () => {
    const dir = copyOf("railway-good");
    writeFileSync(join(dir, IAC), block("railway.md", IAC));
    const findings = railwayFindings(dir);
    assert.deepEqual(findings.map((f) => `${f.severity} ${f.id}`).sort(), [
      "manual railway/config-apply",
      "manual railway/cron-before-cutover",
      "manual railway/private-domain-url",
    ]);
  });

  it("is the only Railway file the bucket and route examples need to pass", () => {
    const dir = copyOf("railway-good");
    writeFileSync(join(dir, "app/services/bucket.server.ts"), block("railway.md", "app/services/bucket.server.ts"));
    assert.deepEqual(railwayFindings(dir).filter((f) => f.file?.startsWith("app/")), []);
  });
});

describe("a project file the script can't read", () => {
  it("asks for a check by hand instead of passing", () => {
    const dir = copyOf("railway-good");
    writeFileSync(join(dir, IAC), 'import config from "./generated.ts";\nexport default config;\n');
    const findings = railwayFindings(dir);
    // with the file unread, it can't see a redis() helper either
    assert.deepEqual(findings.map((f) => `${f.severity} ${f.id}`), ["manual railway/config-unreadable", "manual railway/redis-persistence"]);
  });
});

describe("cron spacing and expiry arithmetic", () => {
  it("finds the shortest gap between runs, across the hour and the day", () => {
    assert.equal(minutesBetweenRuns("*/7 * * * *"), 4); // 10:56, then 11:00
    assert.equal(minutesBetweenRuns("*/5 * * * *"), 5);
    assert.equal(minutesBetweenRuns("0,58 * * * *"), 2);
    assert.equal(minutesBetweenRuns("0 2 * * *"), 1440);
    assert.equal(minutesBetweenRuns("15 */2 * * 1"), 120);
    assert.equal(minutesBetweenRuns("@daily"), null);
    assert.equal(minutesBetweenRuns("0 2 * * MON"), 1440);
  });

  it("evaluates the number expressions people write for expiresIn", () => {
    assert.equal(arithmetic("90 * 24 * 60 * 60"), 7_776_000);
    assert.equal(arithmetic("(7 * 24) * 3600"), 604_800);
    assert.equal(arithmetic("604_800"), 604_800);
    assert.equal(arithmetic("ONE_WEEK"), null);
  });
});
