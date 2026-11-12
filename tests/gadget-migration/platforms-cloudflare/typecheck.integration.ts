// Type-checks every TypeScript block in references/platforms/cloudflare.md on its own, with stubs for the
// app files it imports and the Env that wrangler types generates from the reference's wrangler.jsonc.
// app.integration.ts type-checks the same blocks again inside a whole app.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { block, typecheck, writeProject } from "../platform-blocks.ts";

const here = fileURLToPath(new URL(".", import.meta.url));

// what react-router typegen writes for the server build that workers/app.ts imports
const SERVER_BUILD = `declare module "virtual:react-router/server-build" {
  import { ServerBuild } from "react-router";
${["assets", "assetsBuildDirectory", "basename", "entry", "future", "isSpaMode", "prerender", "publicPath", "routeDiscovery", "routes", "ssr", "allowedActionOrigins", "unstable_getCriticalCss"].map((k) => `  export const ${k}: ServerBuild["${k}"];`).join("\n")}
}
`;

describe("cloudflare.md TypeScript blocks", () => {
  it("typecheck against the Env from wrangler types --env production --strict-vars=false", () => {
    const dir = join(here, ".typecheck");
        // the guide's withDb, so the queries in workers/app.ts are typed instead of stubbed
    const withDb = readFileSync(join(here, "app-fixture/app/db.server.ts"), "utf8");
    const roots = writeProject("cloudflare.md", dir, { "server-build.d.ts": SERVER_BUILD, "vite-env.d.ts": '/// <reference types="vite/client" />\n', "app/db.server.ts": withDb });
    for (const root of roots) {
      writeFileSync(join(root, "wrangler.jsonc"), block("cloudflare.md", "wrangler.jsonc"));
      const types = spawnSync(join(here, "node_modules/.bin/wrangler"), ["types", "--env", "production", "--strict-vars=false"], { cwd: root, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
      assert.equal(types.status, 0, types.stderr);
    }
    typecheck(here, roots, { lib: ["DOM", "DOM.Iterable", "ES2022"] });
  });
});
