// Small readers for the config files the checks look at, with no dependencies. They cover the
// subset of YAML, TOML, and JSONC that platform config files use. Each parsed object remembers the
// line every key came from, which keyLine() returns. A file these readers can't parse makes the
// check report "check by hand", never a pass.

const lines = new WeakMap<object, Map<string | number, number>>();

function remember(target: object, key: string | number, line: number) {
  let map = lines.get(target);
  if (!map) lines.set(target, (map = new Map()));
  map.set(key, line);
}

// The 1-based line a key or array index was read from, or undefined.
export function keyLine(target: unknown, key: string | number): number | undefined {
  return target && typeof target === "object" ? lines.get(target)?.get(key) : undefined;
}

// The 1-based line of the first match of a pattern, or undefined.
export function lineOf(text: string, pattern: RegExp | string): number | undefined {
  const index = typeof pattern === "string" ? text.indexOf(pattern) : text.search(pattern);
  return index < 0 ? undefined : lineAt(text, index);
}

export function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

// ---------------------------------------------------------------------------------------------
// JSONC: JSON with comments and trailing commas, as in wrangler.jsonc and vercel.json

export function parseJsonc(text: string): any {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const comment = text.slice(i, end < 0 ? text.length : end + 2);
      out += comment.replace(/[^\n]/g, " ");
      i = end < 0 ? text.length : end + 1;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

// ---------------------------------------------------------------------------------------------
// YAML: block mappings and sequences, plain and quoted scalars, flow [] and {}, block scalars

interface YamlLine {
  indent: number;
  text: string;
  line: number;
}

function stripYamlComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text.trimEnd();
}

function yamlScalar(raw: string): any {
  const value = raw.trim();
  if (value === "" || value === "~" || value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    return inner === "" ? [] : splitFlow(inner).map(yamlScalar);
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    const inner = value.slice(1, -1).trim();
    const object: Record<string, any> = {};
    if (inner) {
      for (const part of splitFlow(inner)) {
        const colon = part.indexOf(":");
        object[String(yamlScalar(part.slice(0, colon)))] = yamlScalar(part.slice(colon + 1));
      }
    }
    return object;
  }
  return value;
}

function splitFlow(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts.map((p) => p.trim());
}

const YAML_KEY = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^\s#'"\[\]{},:-][^:]*?|-[^\s:][^:]*?)\s*:(?:\s+(.*))?$/;

export function parseYaml(text: string): any {
  const raw = text.split("\n");
  const rows: YamlLine[] = [];
  raw.forEach((source, index) => {
    if (source.trim() === "---") return;
    const stripped = stripYamlComment(source.replace(/\t/g, "  "));
    if (stripped.trim() === "") return;
    rows.push({ indent: stripped.length - stripped.trimStart().length, text: stripped.trim(), line: index + 1 });
  });
  let pos = 0;

  function blockScalar(parentIndent: number, folded: boolean): string {
    const parts: string[] = [];
    // block scalars keep comment-looking lines and blank lines, so read the raw source
    const startLine = rows[pos - 1].line;
    let i = startLine;
    let indent = -1;
    for (; i < raw.length; i++) {
      const source = raw[i];
      if (source.trim() === "") {
        parts.push("");
        continue;
      }
      const sourceIndent = source.length - source.trimStart().length;
      if (sourceIndent <= parentIndent) break;
      if (indent < 0) indent = sourceIndent;
      parts.push(source.slice(indent));
    }
    while (pos < rows.length && rows[pos].line <= i) pos++;
    while (parts.length && parts[parts.length - 1] === "") parts.pop();
    return folded ? parts.join(" ") : parts.join("\n") + "\n";
  }

  function value(rest: string | undefined, indent: number): any {
    if (rest === undefined || rest === "") {
      const next = rows[pos];
      if (!next) return null;
      if (next.indent > indent) return block(next.indent);
      if (next.indent === indent && next.text.startsWith("- ")) return sequence(indent);
      if (next.indent === indent && next.text === "-") return sequence(indent);
      return null;
    }
    if (/^[|>][-+]?$/.test(rest)) return blockScalar(indent, rest.startsWith(">"));
    return yamlScalar(rest);
  }

  function mapping(indent: number): Record<string, any> {
    const object: Record<string, any> = {};
    while (pos < rows.length && rows[pos].indent === indent && !rows[pos].text.startsWith("- ") && rows[pos].text !== "-") {
      const row = rows[pos];
      const match = row.text.match(YAML_KEY);
      if (!match) throw new Error(`line ${row.line}: expected "key: value"`);
      const key = String(yamlScalar(match[1]));
      pos++;
      remember(object, key, row.line);
      object[key] = value(match[2], indent);
    }
    return object;
  }

  function sequence(indent: number): any[] {
    const array: any[] = [];
    while (pos < rows.length && rows[pos].indent === indent && (rows[pos].text.startsWith("- ") || rows[pos].text === "-")) {
      const row = rows[pos];
      const content = row.text === "-" ? "" : row.text.slice(2).trimStart();
      remember(array, array.length, row.line);
      if (content === "") {
        pos++;
        array.push(value(undefined, indent));
      } else if (YAML_KEY.test(content) && !/^["'].*["']$/.test(content)) {
        // "- key: value" starts a mapping whose keys line up with "key"
        const contentIndent = indent + (row.text.length - content.length);
        rows[pos] = { indent: contentIndent, text: content, line: row.line };
        array.push(mapping(contentIndent));
      } else {
        pos++;
        array.push(yamlScalar(content));
      }
    }
    return array;
  }

  function block(indent: number): any {
    const row = rows[pos];
    if (row.text.startsWith("- ") || row.text === "-") return sequence(indent);
    return mapping(indent);
  }

  if (rows.length === 0) return null;
  const result = block(rows[0].indent);
  if (pos < rows.length) throw new Error(`line ${rows[pos].line}: unexpected indentation`);
  return result;
}

// ---------------------------------------------------------------------------------------------
// TOML: tables, arrays of tables, dotted keys, strings, numbers, booleans, arrays, inline tables

export function parseToml(text: string): any {
  const root: Record<string, any> = {};
  let current: Record<string, any> = root;
  let i = 0;
  let line = 1;

  const peek = () => text[i];
  const advance = () => {
    if (text[i] === "\n") line++;
    i++;
  };
  const fail = (message: string): never => {
    throw new Error(`line ${line}: ${message}`);
  };

  function skipSpaces() {
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  }
  function skipComment() {
    if (peek() === "#") while (i < text.length && text[i] !== "\n") i++;
  }
  function skipBlank() {
    for (;;) {
      skipSpaces();
      skipComment();
      if (peek() === "\n" || peek() === "\r") advance();
      else break;
    }
  }

  function basicString(): string {
    if (text.startsWith('"""', i)) {
      i += 3;
      if (peek() === "\n") advance();
      const start = i;
      while (i < text.length && !text.startsWith('"""', i)) advance();
      const body = text.slice(start, i);
      i += 3;
      return JSON.parse(`"${body.replace(/\n/g, "\\n").replace(/\r/g, "")}"`);
    }
    advance();
    const start = i;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\n") fail("unterminated string");
      i += text[i] === "\\" ? 2 : 1;
    }
    const body = text.slice(start, i);
    advance();
    return JSON.parse(`"${body}"`);
  }

  function literalString(): string {
    if (text.startsWith("'''", i)) {
      i += 3;
      if (peek() === "\n") advance();
      const start = i;
      while (i < text.length && !text.startsWith("'''", i)) advance();
      const body = text.slice(start, i);
      i += 3;
      return body;
    }
    advance();
    const start = i;
    while (i < text.length && text[i] !== "'") {
      if (text[i] === "\n") fail("unterminated string");
      i++;
    }
    const body = text.slice(start, i);
    advance();
    return body;
  }

  function key(): string {
    skipSpaces();
    if (peek() === '"') return basicString();
    if (peek() === "'") return literalString();
    const start = i;
    while (i < text.length && /[A-Za-z0-9_-]/.test(text[i])) i++;
    if (i === start) fail(`expected a key, found ${JSON.stringify(text.slice(i, i + 10))}`);
    return text.slice(start, i);
  }

  function dottedKey(): string[] {
    const parts = [key()];
    skipSpaces();
    while (peek() === ".") {
      i++;
      parts.push(key());
      skipSpaces();
    }
    return parts;
  }

  function value(): any {
    skipSpaces();
    const c = peek();
    if (c === '"') return basicString();
    if (c === "'") return literalString();
    if (c === "[") {
      advance();
      const array: any[] = [];
      for (;;) {
        skipBlank();
        if (peek() === "]") {
          advance();
          return array;
        }
        array.push(value());
        skipBlank();
        if (peek() === ",") advance();
        else if (peek() !== "]") fail("expected , or ] in array");
      }
    }
    if (c === "{") {
      advance();
      const table: Record<string, any> = {};
      skipSpaces();
      if (peek() === "}") {
        advance();
        return table;
      }
      for (;;) {
        const startLine = line;
        const path = dottedKey();
        skipSpaces();
        if (peek() !== "=") fail("expected = in inline table");
        advance();
        assign(table, path, value(), startLine);
        skipSpaces();
        if (peek() === ",") advance();
        else if (peek() === "}") {
          advance();
          return table;
        } else fail("expected , or } in inline table");
      }
    }
    const start = i;
    while (i < text.length && !/[\s,\]}#]/.test(text[i])) i++;
    const raw = text.slice(start, i);
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (/^[+-]?(\d[\d_]*)(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(raw)) return Number(raw.replace(/_/g, ""));
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw;
    return fail(`unsupported value ${JSON.stringify(raw)}`);
  }

  function assign(table: Record<string, any>, path: string[], v: any, at: number) {
    let target = table;
    for (const part of path.slice(0, -1)) {
      if (!(part in target)) {
        target[part] = {};
        remember(target, part, at);
      }
      target = target[part];
    }
    const last = path[path.length - 1];
    target[last] = v;
    remember(target, last, at);
  }

  function tableAt(path: string[], arrayOfTables: boolean, at: number): Record<string, any> {
    let target = root;
    path.forEach((part, index) => {
      const isLast = index === path.length - 1;
      if (isLast && arrayOfTables) {
        if (!Array.isArray(target[part])) {
          target[part] = [];
          remember(target, part, at);
        }
        const table = {};
        remember(target[part], target[part].length, at);
        target[part].push(table);
        target = table;
        return;
      }
      if (!(part in target)) {
        target[part] = {};
        remember(target, part, at);
      }
      target = Array.isArray(target[part]) ? target[part][target[part].length - 1] : target[part];
    });
    return target;
  }

  for (;;) {
    skipBlank();
    if (i >= text.length) break;
    const at = line;
    if (peek() === "[") {
      const arrayOfTables = text[i + 1] === "[";
      i += arrayOfTables ? 2 : 1;
      const path = dottedKey();
      skipSpaces();
      if (!text.startsWith(arrayOfTables ? "]]" : "]", i)) fail("expected ] after table name");
      i += arrayOfTables ? 2 : 1;
      current = tableAt(path, arrayOfTables, at);
    } else {
      const path = dottedKey();
      skipSpaces();
      if (peek() !== "=") fail("expected =");
      advance();
      assign(current, path, value(), at);
    }
    skipSpaces();
    skipComment();
    if (i < text.length && peek() !== "\n" && peek() !== "\r") fail(`unexpected ${JSON.stringify(text.slice(i, i + 10))}`);
  }
  return root;
}

// ---------------------------------------------------------------------------------------------
// Dockerfile: instructions with continuation lines joined

export interface DockerInstruction {
  instruction: string;
  args: string;
  line: number;
}

export function parseDockerfile(text: string): DockerInstruction[] {
  const out: DockerInstruction[] = [];
  const rows = text.split("\n");
  for (let index = 0; index < rows.length; index++) {
    let row = rows[index];
    if (/^\s*(#|$)/.test(row)) continue;
    const start = index;
    while (/\\\s*$/.test(row) && index + 1 < rows.length) {
      index++;
      row = row.replace(/\\\s*$/, " ") + rows[index].trim();
    }
    const match = row.trim().match(/^(\w+)\s+([\s\S]*)$/);
    if (match) out.push({ instruction: match[1].toUpperCase(), args: match[2].trim(), line: start + 1 });
  }
  return out;
}

// The command a Dockerfile CMD or ENTRYPOINT runs, as one string, from the exec or shell form.
export function dockerCommand(args: string): string {
  if (args.startsWith("[")) {
    try {
      return (JSON.parse(args) as string[]).join(" ");
    } catch {
      return args;
    }
  }
  return args;
}
