// Typechecks the TypeScript blocks in azure.md with the packages they name, inside a stand-in for
// Shopify's app template: relative imports no block defines, such as ../shopify.server, become stubs.
// Run with: npm test (from this folder)
import { join } from "node:path";
import { describe, it } from "node:test";
import { typecheck, writeProject } from "../platform-blocks.ts";

const here = import.meta.dirname;

describe("azure.md TypeScript", () => {
  it("typechecks with @azure/service-bus 7.10.0, @azure/identity 4.14.1, react-router 7.18.2, and TypeScript 5.9.3", () => {
    const roots = writeProject("azure.md", join(here, ".typecheck", "project"));
    typecheck(here, roots, { types: ["node"], lib: ["ES2022", "DOM", "DOM.Iterable"] });
  });
});
