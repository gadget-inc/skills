// Validates the fly.toml files in fly-io.md with flyctl's own validation, and typechecks the reference's
// TypeScript. platforms-fly-io.test.ts runs the preflight checks on the same files.
// flyctl needs a token but not the API for `config validate`, so any value works. Set FLYCTL to the
// flyctl binary, or put flyctl on PATH; without it the validation test skips.
// Run with: npm test (from this folder)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { block, typecheck, writeProject } from "../platform-blocks.ts";

const here = import.meta.dirname;
const flyctl = process.env.FLYCTL ?? "flyctl";
const found = spawnSync(flyctl, ["version"], { encoding: "utf8" });
const skip = found.status === 0 ? false : "set FLYCTL to a flyctl binary";

function validate(path: string) {
  return spawnSync(flyctl, ["config", "validate", "--strict", "-c", path], {
    encoding: "utf8",
    env: { ...process.env, FLY_API_TOKEN: "fo1_offline-validation", HOME: join(here, ".typecheck", "flyctl-home"), NO_COLOR: "1" },
  });
}

describe("fly.toml files in fly-io.md", { skip }, () => {
  const dir = join(here, ".typecheck", "fly-config");
  mkdirSync(dir, { recursive: true });

  for (const path of ["fly.toml", "fly.staging.toml"]) {
    it(`${path} passes fly config validate --strict`, () => {
      writeFileSync(join(dir, path), block("fly-io.md", path));
      const result = validate(join(dir, path));
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, /Configuration is valid/);
    });
  }

  it("fails the errors the failure table quotes", () => {
    const production = block("fly-io.md", "fly.toml");
    writeFileSync(join(dir, "no-processes.toml"), production.replace('  processes = ["web"]\n  internal_port', "  internal_port"));
    assert.match(validate(join(dir, "no-processes.toml")).stdout, /Service has no processes set but app has 3 processes defined/);
    writeFileSync(join(dir, "typo.toml"), production.replace("kill_timeout = 300", "kill_timeout = 300\nauto_stop = true"));
    const typo = validate(join(dir, "typo.toml"));
    assert.notEqual(typo.status, 0);
    assert.match(typo.stdout + typo.stderr, /Strict validation found unrecognised sections or keys:\s+- auto_stop/);
  });
});

describe("fly-io.md TypeScript", () => {
  it("typechecks with TypeScript 5.9.3", () => {
    const roots = writeProject("fly-io.md", join(here, ".typecheck", "project"));
    typecheck(here, roots, { types: ["node"] });
  });
});
