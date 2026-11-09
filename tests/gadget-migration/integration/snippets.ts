// Pulls code blocks out of the skill's reference files by the path comment on their first line,
// so the tests run exactly the code the references show.
import { readFileSync } from "node:fs";
import * as nodeModule from "node:module";

const referencesDir = new URL("../../../skills/gadget/gadget-migration/references/", import.meta.url);

export function blocks(reference: string, path: string): string[] {
  const markdown = readFileSync(new URL(reference, referencesDir), "utf8");
  const found: string[] = [];
  for (const match of markdown.matchAll(/```(\w+)\n([\s\S]*?)```/g)) {
    const [firstLine] = match[2].split("\n");
    if (firstLine === `-- in ${path}` || firstLine === `// in ${path}`) found.push(match[2]);
  }
  if (found.length === 0) throw new Error(`no code block for ${path} in ${reference}`);
  return found;
}

export function sql(reference: string, path: string): string {
  return blocks(reference, path)[0];
}

// Imports a TypeScript block as a module. Type-only imports are erased, so the block must not
// import runtime values.
export async function importBlock(source: string): Promise<any> {
  const strip = (nodeModule as any).stripTypeScriptTypes as (code: string) => string;
  const js = strip(source);
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}
