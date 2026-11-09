// Runs the export script from references/data-export.md against a stand-in for the generated
// client (fixtures/fake-gadget-client). Run with: node --test "tests/**/*.test.ts"
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { blocks } from "./integration/snippets.ts";

const fakeClient = fileURLToPath(new URL("./fixtures/fake-gadget-client", import.meta.url));
const script = blocks("data-export.md", "scripts/export-model.ts")[0];
const workDirs: string[] = [];

// A scratch project holding the script and the fake client under node_modules.
function project() {
  const dir = mkdtempSync(join(tmpdir(), "gadget-export-"));
  workDirs.push(dir);
  mkdirSync(join(dir, "node_modules", "@gadget-client"), { recursive: true });
  cpSync(fakeClient, join(dir, "node_modules", "@gadget-client", "my-app"), { recursive: true });
  writeFileSync(join(dir, "export-model.ts"), script);
  return dir;
}

function run(dir: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--import", join(fakeClient, "instant-timers.js"), "export-model.ts", ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GADGET_EXPORT_API_KEY: "test-key", FAKE_CALL_LOG: join(dir, "calls.log"), FAKE_WAIT_LOG: join(dir, "waits.log"), ...env },
  });
}

const lines = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean);
const ids = (file: string) => lines(file).map((line) => Number(JSON.parse(line).id));
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

after(() => workDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("the export script in data-export.md", () => {
  it("writes every record once, in id order, 250 per request", () => {
    const dir = project();
    const result = run(dir, ["widget"], { FAKE_TOTAL: "600" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /exported 600 records from widget/);
    assert.deepEqual(ids(join(dir, "widget.ndjson")), range(1, 600));
    const calls = lines(join(dir, "calls.log")).map((line) => JSON.parse(line));
    assert.deepEqual(calls, [{ model: "widget", first: 250 }, { model: "widget", first: 250, after: "250" }, { model: "widget", first: 250, after: "500" }]);
    // quotes, backslashes, and non-ASCII text survive as one JSON document per line
    assert.equal(JSON.parse(lines(join(dir, "widget.ndjson"))[0]).name, 'record "1" \\ ünï');
  });

  it("waits and retries when a request fails, with a longer wait each time", () => {
    const dir = project();
    const result = run(dir, ["widget"], { FAKE_TOTAL: "600", FAKE_FAIL_CALLS: "2,3,4" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(ids(join(dir, "widget.ndjson")), range(1, 600));
    assert.deepEqual(lines(join(dir, "waits.log")).map(Number), [2000, 4000, 8000]);
    assert.match(result.stderr, /GGT_TOO_MANY_REQUESTS/);
  });

  it("stops after 8 failed attempts and continues from the saved cursor on the next run", () => {
    const dir = project();
    const failed = run(dir, ["widget"], { FAKE_TOTAL: "600", FAKE_FAIL_CALLS: "2,3,4,5,6,7,8,9" });
    assert.notEqual(failed.status, 0);
    assert.deepEqual(ids(join(dir, "widget.ndjson")), range(1, 250));
    assert.equal(readFileSync(join(dir, "widget.cursor"), "utf8"), "250");
    // no wait is longer than a minute
    assert.equal(Math.max(...lines(join(dir, "waits.log")).map(Number)), 60_000);

    const resumed = run(dir, ["widget"], { FAKE_TOTAL: "600" });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.deepEqual(ids(join(dir, "widget.ndjson")), range(1, 600));
  });

  it("repeats one page, and skips none, when a run dies before saving its cursor", () => {
    const dir = project();
    const died = run(dir, ["widget"], { FAKE_TOTAL: "600", FAKE_DIE_AFTER_PAGE: "2" });
    assert.equal(died.status, 1);
    assert.deepEqual(ids(join(dir, "widget.ndjson")), range(1, 500));
    assert.equal(readFileSync(join(dir, "widget.cursor"), "utf8"), "250");

    const resumed = run(dir, ["widget"], { FAKE_TOTAL: "600", FAKE_DIE_AFTER_PAGE: "2" });
    assert.equal(resumed.status, 0, resumed.stderr);
    const exported = ids(join(dir, "widget.ndjson"));
    assert.equal(exported.length, 850); // page 2 is in the file twice, which is why the load is an upsert
    assert.deepEqual([...new Set(exported)].sort((a, b) => a - b), range(1, 600));
  });

  it("reaches a namespaced model and names its files after it", () => {
    const dir = project();
    const result = run(dir, ["billing/invoice"], { FAKE_TOTAL: "3" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(ids(join(dir, "billing.invoice.ndjson")), [1, 2, 3]);
    assert.equal(JSON.parse(lines(join(dir, "calls.log"))[0]).model, "billing/invoice");
  });

  it("exports only changed records to a separate file when given a time", () => {
    const dir = project();
    const result = run(dir, ["widget", "2026-11-01T00:00:00Z"], { FAKE_TOTAL: "2" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(lines(join(dir, "calls.log"))[0]).filter, { updatedAt: { greaterThan: "2026-11-01T00:00:00Z" } });
    assert.deepEqual(ids(join(dir, "widget.changes.ndjson")), [1, 2]);
    assert.equal(existsSync(join(dir, "widget.ndjson")), false);
  });

  it("fails with the model's name when the model doesn't exist", () => {
    const dir = project();
    const result = run(dir, ["wigdet"], { FAKE_TOTAL: "2" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no model named wigdet/);
  });
});
