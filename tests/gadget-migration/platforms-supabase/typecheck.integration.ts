// Typechecks every TypeScript block in references/platforms/supabase.md with the template's
// TypeScript version, @types/pg, and supabase-js.
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { typecheck, writeProject } from "../platform-blocks.ts";
import { testDir } from "./helpers.ts";

describe("supabase.md TypeScript blocks", () => {
  it("typecheck", () => {
    const roots = writeProject("supabase.md", join(testDir, ".typecheck/types"));
    assert.ok(roots.length >= 1);
    typecheck(testDir, roots, { types: ["node"], lib: ["ES2022"] });
  });
});
