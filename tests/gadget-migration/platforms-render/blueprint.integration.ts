// The Blueprint in references/platforms/render.md against Render's published JSON schema, the offline
// replacement for `render blueprints validate`, which needs a Render login. Skips without network access.
// Also typechecks the TypeScript blocks in render.md with the template's TypeScript.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { before, describe, it } from "node:test";
import YAML from "yaml";
import { parseYaml } from "../../../skills/gadget/gadget-migration/scripts/checks/read-config.ts";
import { block, typecheck, writeProject } from "../platform-blocks.ts";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js").default;
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/preflight/${name}/render.yaml`, import.meta.url));
const here = fileURLToPath(new URL(".", import.meta.url));

let validate: ((data: unknown) => boolean) & { errors?: { instancePath: string; message?: string }[] | null };
let offline: string | false = false;

before(async () => {
  try {
    const response = await fetch("https://render.com/schema/render.yaml.json", { signal: AbortSignal.timeout(15_000) });
    // the schema uses keywords Ajv's strict mode rejects and a "uri" format it doesn't know
    validate = new Ajv2020({ strict: false, validateFormats: false }).compile(await response.json());
  } catch (error) {
    offline = `can't fetch Render's schema: ${(error as Error).message}`;
  }
});

const errors = () => (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join("\n");

describe("render.yaml against Render's schema", () => {
  it("accepts the Blueprint in render.md", (t) => {
    if (offline) return t.skip(offline);
    const doc = YAML.parse(block("render.md", "render.yaml"));
    assert.ok(validate(doc), errors());
    assert.deepEqual(doc.projects[0].environments.map((e: { name: string }) => e.name), ["production", "staging"]);
  });

  it("accepts the good fixture and rejects the bad one's environment group", (t) => {
    if (offline) return t.skip(offline);
    assert.ok(validate(YAML.parse(readFileSync(fixture("render-good"), "utf8"))), errors());
    assert.equal(validate(YAML.parse(readFileSync(fixture("render-bad"), "utf8"))), false);
    // a group can hold values only, so fromDatabase is an extra property there
    assert.ok(validate.errors!.some((e) => e.instancePath === "/envVarGroups/0/envVars/1"), errors());
  });

  it("rejects a shutdown delay over 300 seconds and an unknown eviction policy", (t) => {
    if (offline) return t.skip(offline);
    const doc = YAML.parse(block("render.md", "render.yaml"));
    doc.projects[0].environments[0].services[1].maxShutdownDelaySeconds = 900;
    assert.equal(validate(doc), false);
    assert.match(errors(), /maxShutdownDelaySeconds must be <= 300/);
  });
});

describe("the skill's YAML reader", () => {
  it("reads the Blueprint in render.md the way a YAML library does, so preflight checks what Render sees", () => {
    const text = block("render.md", "render.yaml");
    assert.deepEqual(parseYaml(text), YAML.parse(text));
  });
});

describe("the TypeScript in render.md", () => {
  it("typechecks with BullMQ 6, ioredis 6, and @renderinc/sdk 1.8.0", () => {
    const roots = writeProject("render.md", `${here}.typecheck`);
    typecheck(here, roots, {});
  });
});
