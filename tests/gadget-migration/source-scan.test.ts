// Run with: node --test "tests/**/*.test.ts"
// The JavaScript scanner in scripts/checks/source-scan.ts that the platform checks match code with.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blocks, calls, mask } from "../../skills/gadget/gadget-migration/scripts/checks/source-scan.ts";

const source = [
  "// never call request.json() before authenticate.webhook",
  'const message = "request.json() failed"; const re = /\\/\\/ not a comment/g; const half = total / 2 / 1;',
  "const text = `body ${await request.json()} and ${`nested ${x}`}`; /* request.formData() */",
  "return /a(b)/.test(s) ? request.formData() : 1;",
  "const url = 'https://example.com//path'; foo(); // trailing request.json()",
].join("\n");

describe("mask", () => {
  it("blanks comments and string contents and keeps every index and line", () => {
    const code = mask(source);
    assert.equal(code.length, source.length);
    assert.equal(code.split("\n").length, source.split("\n").length);
    assert.equal(code.split("\n")[0].trim(), "");
    assert.match(code, /const message = " +";/);
    // a regular expression literal and a division aren't comments
    assert.match(code, /const half = total \/ 2 \/ 1;/);
    // code inside a template expression stays
    assert.match(code, /\$\{await request\.json\(\)\}/);
    assert.match(code, /foo\(\);/);
  });

  it("keeps strings when asked, for patterns that match import paths or URLs", () => {
    const code = mask(source, false);
    assert.match(code, /"request\.json\(\) failed"/);
    assert.match(code, /'https:\/\/example\.com\/\/path'; foo\(\);/);
    assert.doesNotMatch(code, /trailing/);
  });
});

describe("calls", () => {
  it("finds calls in code, including inside template expressions, and none in comments or strings", () => {
    const found = calls(source, "\\brequest\\.(?:json|formData)").map((c) => source.slice(c.index, c.close + 1));
    assert.deepEqual(found, ["request.json()", "request.formData()"]);
  });
});

describe("blocks", () => {
  it("starts a function's block at its parameter list", () => {
    const text = "function a(shopId: bigint): void {\n  run();\n}\nconst b = (x: number) => { return x; };\n";
    const code = mask(text);
    const starts = blocks(code).map(([start]) => text[start]);
    assert.deepEqual(starts, ["(", "("]);
    const [[start, end]] = blocks(code);
    assert.ok(text.indexOf("shopId") > start && text.indexOf("shopId") < end);
  });
});
