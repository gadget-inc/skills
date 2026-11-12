// Helpers for the platform reference tests. No dependencies: the typecheck runs the TypeScript
// compiler installed in the calling test folder.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

export const skillDir = fileURLToPath(new URL("../../skills/gadget/gadget-migration/", import.meta.url));
export const platformsDir = join(skillDir, "references/platforms");

export interface Block {
  lang: string;
  // the path from the "// in <path>", "-- in <path>", or "# in <path>" first line
  path: string;
  code: string;
}

// Every code block in a platform reference that names its file on its first line.
export function platformBlocks(reference: string): Block[] {
  const markdown = readFileSync(join(platformsDir, reference), "utf8");
  const out: Block[] = [];
  for (const match of markdown.matchAll(/```(\w*)\n([\s\S]*?)```/g)) {
    const first = match[2].split("\n")[0];
    const named = first.match(/^(?:\/\/|--|#) in (\S+)$/);
    if (named) out.push({ lang: match[1], path: named[1], code: match[2] });
  }
  return out;
}

// The blocks for one path. Throws when the reference has none, so a renamed block fails its test.
export function block(reference: string, path: string, index = 0): string {
  const found = platformBlocks(reference).filter((b) => b.path === path);
  if (!found[index]) throw new Error(`no code block number ${index + 1} for ${path} in ${reference}`);
  return found[index].code;
}

// the clause can't contain "from", so one match never spans two import statements
const RELATIVE_IMPORT = /(?:import|export)\s+(type\s+)?((?:(?!\bfrom\b)[\s\S])*?)\s+from\s+["'](\.{1,2}\/[^"']+)["']/g;

// Writes every TypeScript block of a reference into dir at its path, so blocks that import each
// other resolve, and writes a stub for every relative import no block provides. A stub exports each
// imported name as both an any-typed value and an any type, so the block's own code is what gets
// checked. When two blocks share a path, the later ones go in variants/<n>/ copies of the project.
export function writeProject(reference: string, dir: string, extra: Record<string, string> = {}): string[] {
  rmSync(dir, { recursive: true, force: true });
  const blocks = platformBlocks(reference).filter((b) => /^(ts|tsx|typescript)$/.test(b.lang));
  const layers: Map<string, string>[] = [];
  for (const b of blocks) {
    let layer = layers.findIndex((l) => !l.has(b.path));
    if (layer < 0) layers.push(new Map()), (layer = layers.length - 1);
    layers[layer].set(b.path, b.code);
  }
  const roots: string[] = [];
  layers.forEach((layer, index) => {
    const root = index === 0 ? dir : join(dir, "variants", String(index));
    const files = new Map([...(layers[0] ?? new Map()), ...layer, ...Object.entries(extra)]);
    for (const [path, code] of files) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), code);
    }
    writeStubs(root, files);
    roots.push(root);
  });
  return roots;
}

function writeStubs(root: string, files: Map<string, string>) {
  const stubs = new Map<string, { names: Set<string>; hasDefault: boolean }>();
  for (const [path, code] of files) {
    for (const match of code.matchAll(RELATIVE_IMPORT)) {
      const target = posix.normalize(posix.join(posix.dirname(path), match[3]));
      const candidates = [target, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`, target.replace(/\.js$/, ".ts")];
      if (candidates.some((c) => files.has(c))) continue;
      const entry = stubs.get(target) ?? { names: new Set<string>(), hasDefault: false };
      const clause = match[2].trim();
      const named = clause.match(/\{([\s\S]*)\}/)?.[1] ?? "";
      for (const part of named.split(",")) {
        const name = part.replace(/^\s*type\s+/, "").split(/\s+as\s+/)[0].trim();
        if (name) entry.names.add(name);
      }
      const head = clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, " ").trim();
      if (head && !head.startsWith("*")) entry.hasDefault = true;
      stubs.set(target, entry);
    }
  }
  for (const [target, { names, hasDefault }] of stubs) {
    const file = join(root, /\.(ts|tsx)$/.test(target) ? target : `${target.replace(/\.js$/, "")}.ts`);
    if (existsSync(file)) continue;
    mkdirSync(dirname(file), { recursive: true });
    const lines = ["// stub written by platform-blocks.ts for an import the reference doesn't define"];
    for (const name of names) lines.push(`export declare const ${name}: any;`, `export type ${name} = any;`);
    if (hasDefault) lines.push("declare const stubDefault: any;", "export default stubDefault;");
    if (names.size === 0 && !hasDefault) lines.push("export {};");
    writeFileSync(file, lines.join("\n") + "\n");
  }
}

// Runs tsc --noEmit in each project root with the given compiler options, using the TypeScript
// installed in testDir. Returns tsc's output; throws with it when tsc reports errors.
// TypeScript's globs skip folders that start with a dot, such as .railway, so pass include for those.
export function typecheck(testDir: string, roots: string[], compilerOptions: Record<string, unknown>, include = ["**/*.ts", "**/*.tsx"]) {
  const tsc = join(testDir, "node_modules/typescript/bin/tsc");
  const outputs: string[] = [];
  for (const root of roots) {
    const tsconfig = {
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        jsx: "react-jsx",
        allowImportingTsExtensions: true,
        typeRoots: [join(testDir, "node_modules/@types")],
        ...compilerOptions,
      },
      include,
      exclude: root.endsWith("variants") ? [] : ["variants"],
    };
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));
    try {
      outputs.push(execFileSync(process.execPath, [tsc, "-p", join(root, "tsconfig.json")], { encoding: "utf8", cwd: testDir }));
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      throw new Error(`tsc failed in ${root}:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
    }
  }
  return outputs.join("");
}
