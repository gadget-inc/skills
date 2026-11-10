// A small scanner for JavaScript and TypeScript source, used by the Inngest, Trigger.dev, and Hookdeck
// checks: it skips strings, template literals, and comments, so brackets inside them don't count, and
// reads object literals by their top-level keys.

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

export interface Call {
  // index of the callee's first character, and of the opening parenthesis
  index: number;
  open: number;
  close: number;
}

// Every call that matches `callee`, a regular expression source that ends just before the "(".
export function calls(text: string, callee: string): Call[] {
  const out: Call[] = [];
  for (const m of text.matchAll(new RegExp(`${callee}\\s*\\(`, "g"))) {
    const open = m.index! + m[0].length - 1;
    const close = closing(text, open);
    if (close > 0) out.push({ index: m.index!, open, close });
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
