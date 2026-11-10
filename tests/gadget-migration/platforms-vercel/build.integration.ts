// Runs vercel build, offline with a hand-written .vercel/project.json, on a React Router app with the
// @vercel/react-router preset and on a Next.js app, each with its vercel.json from references/platforms/vercel.md.
// Also reproduces two failure signatures from the reference: unused_function, and the 405 a schedule's
// POST gets from a route that only has a loader.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createRequestHandler } from "react-router";
import { block } from "../platform-blocks.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const vercel = join(here, "node_modules/.bin/vercel");
// the vercel.json blocks without their "// in vercel.json" line
const vercelJson = (index: number) => block("vercel.md", "vercel.json", index).split("\n").slice(1).join("\n");

function project(name: string, framework: string): string {
  const dir = join(here, ".work", name);
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(here, "app-fixture", name), dir, { recursive: true });
  mkdirSync(join(dir, ".vercel"), { recursive: true });
  writeFileSync(join(dir, ".vercel/project.json"), JSON.stringify({ projectId: "prj_example", orgId: "team_example", settings: { framework } }));
  return dir;
}

function build(dir: string) {
  const result = spawnSync(vercel, ["build", "--yes"], { cwd: dir, encoding: "utf8", env: { ...process.env, VERCEL_TELEMETRY_DISABLED: "1", NEXT_TELEMETRY_DISABLED: "1" }, timeout: 300_000 });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const vcConfig = (dir: string, fn: string) => JSON.parse(readFileSync(join(dir, ".vercel/output/functions", fn, ".vc-config.json"), "utf8"));

describe("vercel build on React Router with the reference's vercel.json", () => {
  const dir = project("react-router", "react-router");

  it("builds, and the output carries both schedules", () => {
    writeFileSync(join(dir, "vercel.json"), vercelJson(0));
    const result = build(dir);
    assert.equal(result.status, 0, result.output);
    const config = JSON.parse(readFileSync(join(dir, ".vercel/output/config.json"), "utf8"));
    assert.deepEqual(config.schedules, JSON.parse(vercelJson(0)).schedules);
  });

  it("gives the route that exports config its own function with that maxDuration", () => {
    assert.equal(vcConfig(dir, "api/inngest.func").maxDuration, 800);
    assert.equal(vcConfig(dir, "schedules/prune-audit-logs.func").maxDuration, undefined);
  });

  it("answers a schedule's POST to a loader-only route with 405", async () => {
    const serverDir = readdirSync(join(dir, "build/server")).find((d) => existsSync(join(dir, "build/server", d, "index.js")) && !d.includes("eyJtYXhEdXJhdGlvbiI"))!;
    const handler = createRequestHandler(await import(join(dir, "build/server", serverDir, "index.js")), "production");
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
    try {
      assert.equal((await handler(new Request("http://localhost/schedules/legacy"))).status, 200);
      assert.equal((await handler(new Request("http://localhost/schedules/legacy", { method: "POST" }))).status, 405);
      assert.equal((await handler(new Request("http://localhost/schedules/prune-audit-logs", { method: "POST" }))).status, 401);
    } finally {
      console.error = original;
    }
    assert.ok(errors.some((e) => e.includes('You made a POST request to "/schedules/legacy" but did not provide an `action` for route "routes/schedules.legacy", so there is no way to handle the request.')), errors.join("\n"));
  });

  it("fails the build with unused_function for a functions key on a route file", () => {
    writeFileSync(join(dir, "vercel.json"), JSON.stringify({ functions: { "app/routes/api.inngest.ts": { maxDuration: 800 } } }));
    const result = build(dir);
    assert.notEqual(result.status, 0);
    assert.ok(result.output.includes('Error: [unused_function] The pattern "app/routes/api.inngest.ts" defined in `functions` doesn\'t match any Serverless Functions inside the `api` directory.'), result.output);
  });
});

describe("vercel build on Next.js with the reference's vercel.json", () => {
  it("builds, gives each function its settings, and keeps the private schedule target", () => {
    const dir = project("next", "nextjs");
    const route = "app/api/schedules/prune-audit-logs/route.ts";
    mkdirSync(dirname(join(dir, route)), { recursive: true });
    writeFileSync(join(dir, route), block("vercel.md", route));
    writeFileSync(join(dir, "vercel.json"), vercelJson(1));
    const result = build(dir);
    assert.equal(result.status, 0, result.output);
    assert.equal(vcConfig(dir, "api/inngest.func").maxDuration, 800);
    const scheduled = vcConfig(dir, "api/schedules/prune-audit-logs.func");
    assert.equal(scheduled.maxDuration, 300);
    assert.deepEqual(scheduled.experimentalTriggers, [{ type: "schedule/v1beta" }]);
    const config = JSON.parse(readFileSync(join(dir, ".vercel/output/config.json"), "utf8"));
    assert.deepEqual(config.schedules, { "prune-audit-logs": { schedule: "0 2 * * *", timezone: "UTC", function: "api/schedules/prune-audit-logs" } });
  });
});
