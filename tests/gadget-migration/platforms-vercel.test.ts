// Run with: node --test "tests/**/*.test.ts"
// The Vercel checks in scripts/checks/vercel.ts against fixtures/preflight/vercel-bad and vercel-good,
// and the files in references/platforms/vercel.md against the same checks.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { preflight } from "../../skills/gadget/gadget-migration/scripts/preflight.ts";
import { block } from "./platform-blocks.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/preflight/${name}`, import.meta.url));
const vercelFindings = (dir: string) => preflight(dir, ["vercel"]).findings.filter((f) => f.id.startsWith("vercel/"));
const where = (f: { id: string; file?: string; line?: number }) => `${f.id} ${f.file ?? ""}:${f.line ?? ""}`;

const temps: string[] = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function tempDir(from?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "vercel-preflight-"));
  temps.push(dir);
  if (from) cpSync(fixture(from), dir, { recursive: true });
  return dir;
}
function write(dir: string, path: string, text: string) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}
// a code block without its "// in <path>" line, for JSON files
const json = (path: string, index = 0) => block("vercel.md", path, index).split("\n").slice(1).join("\n");

describe("Vercel checks on vercel-bad", () => {
  const findings = vercelFindings(fixture("vercel-bad"));
  const expected: [string, "error" | "warning" | "manual", string | undefined, number | undefined][] = [
    ["vercel/functions-react-router", "error", "vercel.json", 5],
    ["vercel/schedules-before-cutover", "manual", "vercel.json", 7],
    // no CRON_SECRET check
    ["vercel/schedule-unprotected", "error", "app/routes/schedules.prune-audit-logs.tsx", 4],
    // a loader for the older Cron Jobs' GET, and a schedule that sends POST
    ["vercel/schedule-method", "error", "app/routes/schedules.reconcile-shops.tsx", 5],
    // the functions entry for this route doesn't apply in React Router
    ["vercel/inngest-max-duration", "warning", "app/routes/api.inngest.ts", 1],
    ["vercel/webhook-waituntil", "warning", "app/routes/webhooks.orders.create.tsx", 8],
    ["vercel/pg-pool", "warning", "app/pool.server.ts", 3],
    ["vercel/multipart-upload", "warning", "app/routes/api.uploads.ts", 2],
    ["vercel/deployment-url", "error", "shopify.app.toml", 3],
    ["vercel/preview-database", "manual", "package.json", 6],
    ["vercel/deployment-protection", "manual", undefined, undefined],
  ];

  for (const [id, severity, file, line] of expected) {
    it(`reports ${id} at ${file ?? "no file"}:${line ?? ""}`, () => {
      const found = findings.find((f) => f.id === id && f.file === file && f.line === line);
      assert.ok(found, `missing ${id} at ${file}:${line}; got:\n${findings.map(where).join("\n")}`);
      assert.equal(found.severity, severity);
      assert.ok(found.fix.length > 0 && found.message.length > 0);
      assert.match(found.docs ?? "", /^https:\/\/docs\.gadget\.dev\/guides\/moving-to-another-platform\/vercel#/);
    });
  }

  it("reports nothing else", () => {
    assert.equal(findings.length, expected.length, findings.map(where).join("\n"));
  });

  it("gives the error text a reader will see", () => {
    const text = (id: string) => findings.find((f) => f.id === id)?.error;
    assert.equal(text("vercel/functions-react-router"), 'Error: [unused_function] The pattern "app/routes/api.inngest.ts" defined in `functions` doesn\'t match any Serverless Functions inside the `api` directory.');
    assert.equal(text("vercel/schedule-method"), 'You made a POST request to "/schedules/reconcile-shops" but did not provide an `action` for route "routes/schedules.reconcile-shops", so there is no way to handle the request.');
    assert.equal(text("vercel/inngest-max-duration"), "504 FUNCTION_INVOCATION_TIMEOUT");
    assert.equal(text("vercel/multipart-upload"), "413 FUNCTION_PAYLOAD_TOO_LARGE");
  });

  it("mentions Inngest's bypass secret only when the app uses Inngest", () => {
    assert.match(findings.find((f) => f.id === "vercel/deployment-protection")!.fix, /protection bypass secret/);
  });
});

describe("Vercel checks on vercel-good", () => {
  it("reports only what a dashboard or CLI has to show", () => {
    const findings = vercelFindings(fixture("vercel-good"));
    assert.deepEqual(findings.map(where).sort(), ["vercel/deployment-protection :", "vercel/schedules-before-cutover vercel.json:4"]);
    assert.ok(findings.every((f) => f.severity === "manual"));
  });

  it("tells production aliases from deployment and branch URLs", () => {
    const urls: [string, boolean][] = [
      ["https://my-app.vercel.app", false],
      ["https://my-app-my-team.vercel.app", false],
      ["https://shop-sync-2024.vercel.app", false],
      ["https://my-app-4f9c2a1bc-my-team.vercel.app", true],
      ["https://my-app-git-main-my-team.vercel.app", true],
    ];
    for (const [url, flagged] of urls) {
      const dir = tempDir();
      write(dir, "vercel.json", "{}");
      write(dir, "shopify.app.staging.toml", `client_id = "abc"\napplication_url = "${url}"\n`);
      assert.equal(vercelFindings(dir).some((f) => f.id === "vercel/deployment-url"), flagged, url);
    }
  });

  it("drops the template Dockerfile's migrate-on-start, which Vercel never runs", () => {
    const dir = tempDir("vercel-good");
    write(dir, "Dockerfile", 'FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nRUN npm ci\nCMD ["npm", "run", "docker-start"]\n');
    write(dir, "package.json", JSON.stringify({ scripts: { "docker-start": "npm run setup && npm run start", setup: "prisma generate && prisma migrate deploy", start: "react-router-serve ./build/server/index.js" }, dependencies: { "@vercel/react-router": "1.3.7", "@react-router/dev": "7.18.2" } }));
    assert.ok(preflight(dir, []).findings.some((f) => f.id === "common/migrate-on-start"));
    assert.ok(!preflight(dir, ["vercel"]).findings.some((f) => f.id === "common/migrate-on-start"));
  });

  it("asks for a check by hand when vercel.json can't be read", () => {
    const dir = tempDir();
    write(dir, "vercel.json", '{ "regions": ["iad1"] "schedules": {} }');
    const found = vercelFindings(dir);
    assert.deepEqual(found.map((f) => `${f.id} ${f.severity}`), ["vercel/config-unreadable manual"]);
  });
});

describe("Vercel checks on a Next.js app", () => {
  function nextApp() {
    const dir = tempDir();
    write(dir, "package.json", JSON.stringify({ dependencies: { next: "16.4.6", "@vercel/schedules": "0.0.3" } }));
    write(dir, "app/api/inngest/route.ts", 'import { serve } from "inngest/next";\nexport const maxDuration = 800;\nexport const { GET, POST, PUT } = serve({ client, functions });\n');
    return dir;
  }

  it("warns about a functions pattern that matches no file", () => {
    const dir = nextApp();
    write(dir, "vercel.json", JSON.stringify({ functions: { "app/api/**/*.js": { maxDuration: 800 } } }, null, 2));
    assert.deepEqual(vercelFindings(dir).map(where), ["vercel/functions-no-match vercel.json:3"]);
  });

  it("reports a path schedule whose route exports no POST", () => {
    const dir = nextApp();
    write(dir, "vercel.json", JSON.stringify({ schedules: { cleanup: { schedule: "0 3 * * *", path: "/api/cron" } } }, null, 2));
    write(dir, "app/api/cron/route.ts", 'export async function GET(request: Request) {\n  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) return new Response(null, { status: 401 });\n  return new Response("ok");\n}\n');
    const found = vercelFindings(dir).filter((f) => f.id === "vercel/schedule-method");
    assert.deepEqual(found.map(where), ["vercel/schedule-method app/api/cron/route.ts:1"]);
    assert.equal(found[0].error, "405 Method Not Allowed");
  });
});

describe("the files in references/platforms/vercel.md", () => {
  it("pass the checks for React Router, with the guide's schedule route", () => {
    const dir = tempDir();
    write(dir, "vercel.json", json("vercel.json", 0));
    write(dir, "package.json", JSON.stringify({ scripts: { build: "prisma generate && react-router build" }, dependencies: { "@vercel/react-router": "1.3.7", "@react-router/dev": "7.18.2", "@vercel/schedules": "0.0.3" } }));
    write(dir, "app/services/audit-logs.server.ts", block("vercel.md", "app/services/audit-logs.server.ts"));
    // the guide's route, for both paths in the reference's vercel.json
    const route = 'import type { ActionFunctionArgs } from "react-router";\nexport const action = async ({ request }: ActionFunctionArgs) => {\n  const cronSecret = process.env.CRON_SECRET;\n  if (!cronSecret || request.headers.get("authorization") !== `Bearer ${cronSecret}`) return new Response("Unauthorized", { status: 401 });\n  return new Response();\n};\n';
    write(dir, "app/routes/schedules.prune-audit-logs.tsx", route);
    write(dir, "app/routes/schedules.reconcile-shops.tsx", route);
    assert.deepEqual(vercelFindings(dir).map(where), ["vercel/schedules-before-cutover vercel.json:4"]);
  });

  it("pass the checks for Next.js, whose schedule targets a private function", () => {
    const dir = tempDir();
    write(dir, "vercel.json", json("vercel.json", 1));
    write(dir, "package.json", JSON.stringify({ dependencies: { next: "16.4.6", "@vercel/schedules": "0.0.3", inngest: "4.26.2" } }));
    write(dir, "app/api/schedules/prune-audit-logs/route.ts", block("vercel.md", "app/api/schedules/prune-audit-logs/route.ts"));
    write(dir, "app/api/inngest/route.ts", 'import { serve } from "inngest/next";\nexport const { GET, POST, PUT } = serve({ client, functions });\n');
    assert.deepEqual(vercelFindings(dir).map(where), ["vercel/schedules-before-cutover vercel.json:8"]);
  });
});
