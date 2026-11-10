// A small scanner for JavaScript and TypeScript source, used by the Inngest, Trigger.dev, Hookdeck,
// Cloudflare, and Vercel checks: it skips strings, template literals, and comments, so brackets and calls
// inside them don't count, and reads object literals by their top-level keys.

export function skipString(text: string, i: number): number {
  const quote = text[i];
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === quote || text[j] === "\n") return j;
  }
  return text.length;
}

export function skipTemplate(text: string, i: number): number {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === "`") return j;
    else if (text[j] === "$" && text[j + 1] === "{") {
      const end = closing(text, j + 1);
      if (end < 0) return text.length;
      j = end;
    }
  }
  return text.length;
}

// The index of the bracket that closes the one at `open`, or -1.
export function closing(text: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") i = skipString(text, i);
    else if (c === "`") i = skipTemplate(text, i);
    else if (c === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i);
      if (i < 0) return -1;
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
      if (i <= 0) return -1;
    } else if (c in pairs) stack.push(pairs[c]);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

export interface Prop {
  key: string;
  // the value's text, or the key itself for a shorthand property
  value: string;
  // index of the key in the file
  index: number;
  // index of the value in the file
  valueIndex: number;
}

// The top-level properties of the object literal whose `{` is at `open`.
export function props(text: string, open: number): Prop[] {
  const end = closing(text, open);
  if (end < 0) return [];
  const out: Prop[] = [];
  let i = open + 1;
  while (i < end) {
    while (i < end && /[\s,]/.test(text[i])) i++;
    if (text.startsWith("//", i)) {
      i = text.indexOf("\n", i);
      continue;
    }
    if (text.startsWith("/*", i)) {
      i = text.indexOf("*/", i) + 2;
      continue;
    }
    if (i >= end) break;
    const keyStart = i;
    let key = "";
    if (text.startsWith("...", i)) {
      key = "...";
      i += 3;
    } else if (text[i] === '"' || text[i] === "'") {
      const close = skipString(text, i);
      key = text.slice(i + 1, close);
      i = close + 1;
    } else {
      const m = /^[\w$]+/.exec(text.slice(i, i + 200));
      if (!m) {
        i++;
        continue;
      }
      key = m[0];
      i += m[0].length;
      // "async foo() {}" and "get foo() {}"
      const next = /^\s+([\w$]+)\s*\(/.exec(text.slice(i, i + 200));
      if ((key === "async" || key === "get" || key === "set") && next) {
        key = next[1];
        i += next[0].length - 1;
      }
    }
    while (i < end && /\s/.test(text[i])) i++;
    let valueStart = i;
    if (key !== "..." && text[i] === ":") {
      i++;
      while (i < end && /\s/.test(text[i])) i++;
      valueStart = i;
    }
    // read the value up to the next top-level comma
    let j = i;
    while (j < end && text[j] !== ",") {
      const c = text[j];
      if (c === "(" || c === "[" || c === "{") {
        const close = closing(text, j);
        if (close < 0) return out;
        j = close + 1;
      } else if (c === '"' || c === "'") j = skipString(text, j) + 1;
      else if (c === "`") j = skipTemplate(text, j) + 1;
      else j++;
    }
    const value = valueStart === i && key !== "..." && text[keyStart] !== "." && text.slice(valueStart, j).trim() === "" ? key : text.slice(valueStart, j).trim();
    out.push({ key, value, index: keyStart, valueIndex: valueStart });
    i = j + 1;
  }
  return out;
}

// Characters after which a "/" starts a regular expression literal rather than a division.
const BEFORE_REGEX = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const KEYWORDS_BEFORE_REGEX = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof"]);

// The index of the "/" that ends the regular expression literal starting at `i`, or -1 when it isn't one.
function skipRegex(text: string, i: number): number {
  let inClass = false;
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === "\n") return -1;
    if (c === "\\") j++;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return j;
  }
  return -1;
}

// The text with comments replaced by spaces and, unless `strings` is false, the contents of strings,
// template literals, and regular expression literals too, keeping their quotes and the code inside
// template expressions. Indexes and line numbers stay put, so a match in the result points at the same
// place in the text. Use it so a pattern only matches code: `request.json()` in a comment, or in an error
// message, isn't a call.
export function mask(text: string, strings = true): string {
  const out = text.split("");
  const wipe = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const regexAllowed = (last: number) => {
    if (last < 0) return true;
    const c = text[last];
    if (BEFORE_REGEX.has(c)) return true;
    if (!/[\w$]/.test(c)) return false;
    const word = /[\w$]+$/.exec(text.slice(Math.max(0, last - 12), last + 1))?.[0] ?? "";
    return KEYWORDS_BEFORE_REGEX.has(word);
  };
  // code from `i` up to the "}" that closes a template expression when `nested`, or the end; returns that index
  const code = (i: number, nested: boolean): number => {
    let depth = 0;
    let last = -1;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === "/" && text[i + 1] === "/") {
        const end = text.indexOf("\n", i);
        const stop = end < 0 ? text.length : end;
        wipe(i, stop);
        i = stop - 1;
        continue;
      }
      if (c === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        const stop = end < 0 ? text.length : end + 2;
        wipe(i, stop);
        i = stop - 1;
        continue;
      }
      if (c === '"' || c === "'") {
        const end = skipString(text, i);
        if (strings) wipe(i + 1, end);
        i = end;
        last = i;
        continue;
      }
      if (c === "`") {
        i = template(i);
        last = i;
        continue;
      }
      if (c === "/" && regexAllowed(last)) {
        const end = skipRegex(text, i);
        if (end > 0) {
          if (strings) wipe(i + 1, end);
          i = end;
          last = i;
          continue;
        }
      }
      if (c === "{") depth++;
      else if (c === "}") {
        if (nested && depth === 0) return i;
        depth--;
      }
      if (!/\s/.test(c)) last = i;
    }
    return text.length;
  };
  // the template literal whose "`" is at `i`; returns the index of the closing "`"
  const template = (i: number): number => {
    let part = i + 1;
    let j = i + 1;
    for (; j < text.length; j++) {
      if (text[j] === "\\") j++;
      else if (text[j] === "`") break;
      else if (text[j] === "$" && text[j + 1] === "{") {
        if (strings) wipe(part, j);
        j = code(j + 2, true);
        part = j + 1;
      }
    }
    if (strings) wipe(part, j);
    return j;
  };
  code(0, false);
  return out.join("");
}

// mask() is called for the same file by several checks, so keep the last few results
const masked = new Map<string, string>();
function maskedCode(text: string): string {
  let result = masked.get(text);
  if (result === undefined) {
    result = mask(text);
    if (masked.size > 64) masked.delete(masked.keys().next().value!);
    masked.set(text, result);
  }
  return result;
}

export interface Call {
  // index of the callee's first character, and of the opening parenthesis
  index: number;
  open: number;
  close: number;
}

// Every call that matches `callee`, a regular expression source that ends just before the "(". Calls in
// comments and strings don't count.
export function calls(text: string, callee: string): Call[] {
  const out: Call[] = [];
  for (const m of maskedCode(text).matchAll(new RegExp(`${callee}\\s*\\(`, "g"))) {
    const open = m.index! + m[0].length - 1;
    const close = closing(text, open);
    if (close > 0) out.push({ index: m.index!, open, close });
  }
  return out;
}

// The { ... } blocks of code from mask(), as [start, end] index pairs. A block right after a parameter
// list, as in `(shopId: bigint) => {` or `function f(shopId: bigint): void {`, starts at the "(", so a
// parameter belongs to its function's block and not to the code around it.
export function blocks(code: string): [number, number][] {
  const out: [number, number][] = [];
  const braces: number[] = [];
  const parens: number[] = [];
  const parenOpen = new Map<number, number>();
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "(") parens.push(i);
    else if (c === ")") {
      const open = parens.pop();
      if (open !== undefined) parenOpen.set(i, open);
    } else if (c === "{") braces.push(i);
    else if (c === "}") {
      const open = braces.pop();
      if (open === undefined) continue;
      const before = code.slice(Math.max(0, open - 200), open);
      const params = /\)\s*(?::[^(){};=]*)?(?:=>)?\s*$/.exec(before);
      out.push([params ? (parenOpen.get(open - before.length + params.index) ?? open) : open, i]);
    }
  }
  return out;
}

// The index of the first non-space character after `i`.
export function nextToken(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

// The text with every match's span replaced by spaces, so indexes and line numbers stay put.
export function blank(text: string, spans: [number, number][]): string {
  const chars = text.split("");
  for (const [start, end] of spans) for (let i = start; i <= end && i < chars.length; i++) if (chars[i] !== "\n") chars[i] = " ";
  return chars.join("");
}

// Spans of every `$transaction(...)` and `.transaction(...)` call: Prisma, Drizzle, Knex, Kysely.
export function transactionSpans(text: string): [number, number][] {
  return [...calls(text, "\\$transaction"), ...calls(text, "\\.transaction")].map((c) => [c.open, c.close]);
}
