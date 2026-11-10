// Checks for apps moving to Inngest. references/platforms/inngest.md explains each one.
import { DOCS, type CheckModule, type Finding, type Repo } from "./types.ts";
import { lineAt, lineOf } from "./read-config.ts";
import { skipString, skipTemplate, closing, props, calls, nextToken, blank, blocks, mask, transactionSpans, type Prop } from "./source-scan.ts";

const GUIDE = `${DOCS}/inngest`;


// ---------------------------------------------------------------------------------------------

interface InngestFunction {
  file: string;
  text: string;
  name: string | null;
  line: number;
  config: Map<string, Prop>;
  configText: string;
  // the handler's body, or "" when the handler isn't an inline function
  body: string;
  bodyIndex: number;
  events: string[];
  cron: boolean;
}

const quoted = (value: string) => /^(["'`])([\s\S]*)\1$/.exec(value.trim())?.[2] ?? null;

function inngestClients(repo: Repo): string[] {
  const names = new Set<string>();
  for (const file of repo.sourceFiles()) for (const m of (repo.read(file) ?? "").matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*new\s+Inngest\s*\(/g)) names.add(m[1]);
  return [...names];
}

function functionsIn(repo: Repo, clients: string[]): InngestFunction[] {
  const out: InngestFunction[] = [];
  if (clients.length === 0) return out;
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file) ?? "";
    for (const call of calls(text, `\\b(?:${clients.join("|")})\\.createFunction`)) {
      const configOpen = nextToken(text, call.open + 1);
      if (text[configOpen] !== "{") continue;
      const configClose = closing(text, configOpen);
      const config = new Map(props(text, configOpen).map((p) => [p.key, p]));
      const configText = text.slice(configOpen, configClose + 1);
      // the handler: async ({ event, step }) => { ... }
      const rest = text.slice(configClose + 1, call.close);
      const arrow = /=>\s*\{/.exec(rest) ?? /function\s*[\w$]*\s*\([^)]*\)\s*\{/.exec(rest);
      let body = "";
      let bodyIndex = 0;
      if (arrow) {
        const open = configClose + 1 + arrow.index + arrow[0].length - 1;
        const close = closing(text, open);
        if (close > 0) {
          body = text.slice(open, close + 1);
          bodyIndex = open;
        }
      }
      const before = text.slice(Math.max(0, call.index - 200), call.index);
      const name = /(?:const|let|var)\s+([\w$]+)\s*=\s*$/.exec(before)?.[1] ?? null;
      const triggers = config.get("triggers")?.value ?? "";
      out.push({
        file,
        text,
        name,
        line: lineAt(text, call.index),
        config,
        configText,
        body,
        bodyIndex,
        events: [...triggers.matchAll(/event\s*:\s*(["'`])([^"'`]+)\1/g)].map((m) => m[2]),
        cron: /cron\s*:|cron\s*\(/.test(triggers),
      });
    }
  }
  return out;
}

// The text of a value, following an identifier to the `const NAME = ...` that defines it, or to
// `exports.NAME = ...` or `module.exports = { NAME: ... }` in a CommonJS module.
function resolve(repo: Repo, file: string, value: string): string {
  if (!/^[\w$]+$/.test(value)) return value;
  const name = value.replace(/\$/g, "\\$");
  const assignment = new RegExp(`(?:(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?|\\b(?:module\\.)?exports\\.${name}\\s*)=\\s*`);
  for (const f of [file, ...repo.sourceFiles().filter((x) => x !== file)]) {
    const text = repo.read(f) ?? "";
    // match in code only, then read the value from the text, where the indexes are the same
    const code = mask(text, false);
    const m = assignment.exec(code);
    if (m) {
      const start = m.index + m[0].length;
      if ("[{(".includes(text[start])) {
        const end = closing(text, start);
        if (end > 0) return text.slice(start, end + 1);
      }
      return text.slice(start, text.indexOf("\n", start));
    }
    const exported = /\bmodule\.exports\s*=\s*\{/.exec(code);
    const prop = exported ? props(text, exported.index + exported[0].length - 1).find((p) => p.key === value && p.value !== value) : undefined;
    if (prop) return prop.value;
  }
  return value;
}

// An import of one of the inngest package's adapters, such as inngest/express or inngest/next, by import or require.
const ADAPTER_IMPORT = /(?:\bfrom\s+|\brequire\s*\(\s*|\bimport\s*\(\s*)["']inngest\/[\w/-]+["']/;

// Every array passed to serve() or connect() as `functions`, as text. Null when one of them isn't
// an array literal the script can read, such as Object.values(all).
function servedArrays(repo: Repo): string[] | null {
  const out: string[] = [];
  let unreadable = false;
  let served = false;
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file) ?? "";
    if (!ADAPTER_IMPORT.test(text)) continue;
    for (const call of [...calls(text, "\\bserve"), ...calls(text, "\\bconnect")]) {
      const open = nextToken(text, call.open + 1);
      if (text[open] !== "{") continue;
      const objects = [open];
      // connect({ apps: [{ client, functions }] })
      const apps = props(text, open).find((p) => p.key === "apps");
      if (apps && text[apps.valueIndex] === "[") for (const m of text.slice(apps.valueIndex, apps.valueIndex + apps.value.length).matchAll(/\{/g)) objects.push(apps.valueIndex + m.index!);
      for (const objectOpen of objects) {
        const fns = props(text, objectOpen).find((p) => p.key === "functions");
        if (!fns) continue;
        served = true;
        const value = resolve(repo, file, fns.value);
        if (value.startsWith("[")) out.push(expandSpreads(repo, file, value));
        else unreadable = true;
      }
    }
  }
  if (unreadable) return null;
  return served ? out : [];
}

// An array's text with each `...name` replaced by the array that name holds, one level deep.
function expandSpreads(repo: Repo, file: string, array: string): string {
  return array.replace(/\.\.\.([\w$]+)/g, (whole, name) => {
    const value = resolve(repo, file, name);
    return value.startsWith("[") ? value : whole;
  });
}

function notServedFindings(repo: Repo, fns: InngestFunction[]): Finding[] {
  const arrays = servedArrays(repo);
  if (arrays === null) return [];
  // no serve() or connect() at all: nothing is served
  const served = arrays.join("\n");
  return fns
    .filter((fn) => fn.name && !new RegExp(`(^|[^\\w$.])${fn.name.replace(/\$/g, "\\$")}([^\\w$]|$)`).test(served))
    .map((fn) => ({
      id: "inngest/function-not-served",
      severity: "error" as const,
      file: fn.file,
      line: fn.line,
      message: arrays.length
        ? `${fn.name} is defined with createFunction but isn't in the functions array passed to serve() or connect(), so Inngest never registers it and it never runs, with no error.`
        : `${fn.name} is defined with createFunction, but no file passes functions to serve() or connect() from an inngest adapter, so Inngest has no endpoint to call and it never runs.`,
      fix: arrays.length
        ? `Add ${fn.name} to the functions array, then sync the app.`
        : 'Add a route that serves the functions, such as app/routes/api.inngest.ts with serve({ client: inngest, functions }) from "inngest/remix", then sync the app.',
      docs: arrays.length ? `${GUIDE}#define-a-function` : `${GUIDE}#serve-the-endpoint`,
    }));
}

// Each event object literal passed to <client>.send(...) or step.sendEvent(id, ...).
interface SentEvent {
  file: string;
  text: string;
  name: string | null;
  data: Prop | undefined;
  index: number;
}

function sentEvents(repo: Repo, clients: string[]): SentEvent[] {
  const out: SentEvent[] = [];
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file) ?? "";
    const found = [...(clients.length ? calls(text, `\\b(?:${clients.join("|")})\\.send`) : []), ...calls(text, "\\bstep\\.sendEvent")];
    for (const call of found) {
      // step.sendEvent takes an id first
      let arg = nextToken(text, call.open + 1);
      if (text.slice(call.index, call.open).includes("sendEvent")) {
        const first = text[arg];
        if (first === '"' || first === "'") arg = nextToken(text, skipString(text, arg) + 1);
        else if (first === "`") arg = nextToken(text, skipTemplate(text, arg) + 1);
        if (text[arg] === ",") arg = nextToken(text, arg + 1);
      }
      const objects: number[] = [];
      if (text[arg] === "{") objects.push(arg);
      else if (text[arg] === "[") {
        const end = closing(text, arg);
        for (let i = arg + 1; i < end; i++) {
          if (text[i] === "{") {
            objects.push(i);
            i = closing(text, i);
          }
        }
      }
      for (const open of objects) {
        const p = props(text, open);
        const name = p.find((x) => x.key === "name");
        out.push({ file, text, name: name ? quoted(name.value) : null, data: p.find((x) => x.key === "data"), index: open });
      }
    }
  }
  return out;
}

interface Declaration {
  name: string;
  at: number;
  // true or false when the declaration says, or the name of the variable it copies
  bigint: boolean | string;
}

// Declarations of names in a file and what they say about bigint: a typed name ("shopId: bigint" in a
// parameter or type) or a const, let, or var, typed by its annotation or its initializer.
function declarations(code: string): Declaration[] {
  const out: Declaration[] = [];
  for (const m of code.matchAll(/\b(?:const|let|var)\s+(?:([\w$]+)\s*(?::\s*([\w$]+)\s*)?=\s*([^;\n]*)|\{([^}=]*)\}\s*(?::[^=]*)?=)|([\w$]+)\s*\??\s*:\s*([\w$]+)/g)) {
    const at = m.index!;
    if (m[6]) out.push({ name: m[5], at, bigint: /^bigint$/i.test(m[6]) });
    else if (m[4] !== undefined) {
      // const { shopId } = ...: the script can't see the type, so the name no longer means an earlier bigint
      for (const part of m[4].split(",")) {
        const local = part.split(":").pop()!.trim();
        if (/^[\w$]+$/.test(local)) out.push({ name: local, at, bigint: false });
      }
    } else {
      const init = m[3].trim();
      const bigint = m[2] ? /^bigint$/i.test(m[2]) : /^BigInt\s*\(|^\d+n\b/.test(init) ? true : /^[\w$]+$/.test(init) ? init : false;
      out.push({ name: m[1], at, bigint });
    }
  }
  return out;
}

function bigintFindings(sent: SentEvent[]): Finding[] {
  const findings: Finding[] = [];
  for (const event of sent) {
    if (!event.data) continue;
    const { text, file } = event;
    // The nearest declaration of a name before the send, in a block that also holds the send, says its
    // type. A parameter belongs to its function, and a property in a type such as { shopId: bigint } to
    // its braces, so neither reaches a const with the same name elsewhere.
    const code = mask(text);
    const decls = declarations(code);
    const scopes = blocks(code);
    const visible = (d: number, at: number) => scopes.every(([a, b]) => !(d > a && d < b) || (at > a && at < b));
    const isBigint = (name: string, at: number, depth = 0): boolean => {
      const d = decls.filter((x) => x.name === name && x.at < at && visible(x.at, at)).pop();
      if (!d) return false;
      if (typeof d.bigint === "string") return depth < 5 && d.bigint !== name && isBigint(d.bigint, d.at, depth + 1);
      return d.bigint;
    };
    const visit = (open: number) => {
      for (const prop of props(text, open)) {
        const value = prop.value;
        const bad = /(^|[^\w$.])\d+n\b/.test(value) || /^BigInt\s*\(/.test(value) || (/^[\w$]+$/.test(value) && isBigint(value, prop.index));
        if (bad) {
          findings.push({
            id: "inngest/bigint-in-send",
            severity: "error",
            file,
            line: lineAt(text, prop.index),
            message: `The event's ${prop.key} field is a bigint. inngest.send drops bigint fields without an error, so the event arrives without ${prop.key}, and a concurrency key on it puts the run in the limit shared by every event without the field.`,
            error: `{"shopId": 123n} arrives as {}`,
            fix: `Send it as a string, such as ${prop.key}: String(${value === prop.key ? prop.key : value}).`,
            docs: `${GUIDE}#send-events-after-the-transaction-commits`,
          });
        } else if (text[prop.valueIndex] === "{") visit(prop.valueIndex);
      }
    };
    if (text[event.data.valueIndex] === "{") visit(event.data.valueIndex);
  }
  return findings;
}

// Fields a function's concurrency key, priority, singleton, or idempotency expression reads from event.data.
function keyFields(repo: Repo, fn: InngestFunction): { field: string; option: string }[] {
  const out: { field: string; option: string }[] = [];
  for (const option of ["concurrency", "priority", "idempotency", "singleton", "rateLimit", "throttle", "debounce"]) {
    const prop = fn.config.get(option);
    if (!prop) continue;
    const value = resolve(repo, fn.file, prop.value);
    // only expressions inside strings: the handler's own code isn't a key
    for (const s of value.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)) for (const m of s[2].matchAll(/event\.data\.([\w$]+)/g)) out.push({ field: m[1], option });
  }
  return out;
}

function keyFieldFindings(repo: Repo, fns: InngestFunction[], sent: SentEvent[]): Finding[] {
  const findings: Finding[] = [];
  for (const fn of fns) {
    const fields = keyFields(repo, fn);
    if (!fields.length) continue;
    for (const event of sent) {
      if (!event.name || !fn.events.includes(event.name) || !event.data || event.text[event.data.valueIndex] !== "{") continue;
      const keys = props(event.text, event.data.valueIndex);
      if (keys.some((k) => k.key === "...")) continue;
      for (const { field, option } of fields) {
        if (keys.some((k) => k.key === field)) continue;
        if (option === "priority") continue; // a missing priority field is how the guide gives events the default
        findings.push({
          id: "inngest/key-field-missing",
          severity: "error",
          file: event.file,
          line: lineAt(event.text, event.index),
          message: `This ${event.name} event has no ${field} in its data, and ${fn.name ?? "the function it triggers"} reads event.data.${field} in its ${option} option. Every such event shares one limit, as if the function had no key.`,
          fix: `Put ${field} in every ${event.name} event's data, as a string.`,
          docs: `${GUIDE}#limit-concurrency-per-store`,
        });
      }
    }
  }
  return findings;
}

function transactionFindings(repo: Repo, clients: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file) ?? "";
    const spans = transactionSpans(text);
    if (!spans.length) continue;
    const sends = [...(clients.length ? calls(text, `\\b(?:${clients.join("|")})\\.send`) : []), ...calls(text, "\\bstep\\.sendEvent")];
    for (const send of sends) {
      if (!spans.some(([a, b]) => send.index > a && send.index < b)) continue;
      findings.push({
        id: "inngest/send-in-transaction",
        severity: "error",
        file,
        line: lineAt(text, send.index),
        message: "This sends an Inngest event inside a database transaction. If the transaction rolls back, the event stays sent and the job runs for a write that never happened. Gadget only queued a background action when its transaction committed.",
        fix: "Send the event after the transaction's await, the way onSuccess ran after run.",
        docs: `${GUIDE}#send-events-after-the-transaction-commits`,
      });
    }
  }
  return findings;
}

function outsideStepFindings(fns: InngestFunction[]): Finding[] {
  const findings: Finding[] = [];
  for (const fn of fns) {
    if (!fn.body) continue;
    const body = fn.body;
    const spans: [number, number][] = [];
    // step.run(...), step.sendEvent(...), and the rest run once and are recorded
    for (const c of calls(body, "\\bstep\\.[\\w$]+")) spans.push([c.index, c.close]);
    // nested functions run where they're called; a call outside a step is an await in the body
    for (const m of body.slice(1).matchAll(/=>\s*\{|function\s*[\w$]*\s*\([^)]*\)\s*\{/g)) {
      const open = 1 + m.index! + m[0].length - 1;
      const close = closing(body, open);
      if (close > 0) spans.push([open, close]);
    }
    const left = blank(body, spans);
    for (const m of left.matchAll(/\bawait\s+(?!Promise\.(?:all|allSettled|race|any)\b|group\.parallel\b)([\w$.]+)/g)) {
      findings.push({
        id: "inngest/work-outside-step",
        severity: "warning",
        file: fn.file,
        line: lineAt(fn.text, fn.bodyIndex + m.index!),
        message: `${fn.name ?? "This function"} awaits ${m[1]} outside step.run. Code outside a step runs again each time the function resumes in a new request, such as after a sleep, a failed step, or a request that reached maxRuntime, so the call repeats.`,
        fix: "Move the call into a step.run, so Inngest records its result and doesn't run it again.",
        docs: `${GUIDE}#make-jobs-safe-to-retry`,
      });
      break;
    }
  }
  return findings;
}

function cronFindings(repo: Repo, fns: InngestFunction[]): Finding[] {
  const findings: Finding[] = [];
  const arrays = [...(servedArrays(repo) ?? [])];
  // also any `functions = [...]` array, for an app whose route the script didn't find
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file) ?? "";
    for (const m of text.matchAll(/\bfunctions\s*(?::[^=]+)?=\s*\[/g)) {
      const open = m.index! + m[0].length - 1;
      const close = closing(text, open);
      if (close > 0) arrays.push(text.slice(open, close + 1));
    }
  }
  for (const fn of fns.filter((f) => f.cron)) {
    if (!fn.config.has("singleton") && /\bstep\.run\s*\(/.test(fn.body)) {
      findings.push({
        id: "inngest/cron-overlap",
        severity: "warning",
        file: fn.file,
        line: fn.line,
        message: `${fn.name ?? "This cron function"} does its work in the cron run and has no singleton. Inngest starts each scheduled run even while the last one is still going, and Gadget skipped it. A cron run also can't be rerun from the Inngest dashboard.`,
        fix: 'Add singleton: { mode: "skip" }, or have the cron only send an event and do the work in an event-triggered function with singleton, which can be rerun.',
        docs: `${GUIDE}#replace-scheduled-actions`,
      });
    }
    // an off switch: the cron is only in the array behind a condition, such as process.env.INNGEST_SCHEDULES
    const element = arrays.flatMap((a) => a.split(/,(?![^[(]*[\])])/)).find((e) => fn.name && new RegExp(`\\b${fn.name}\\b`).test(e));
    if (element && /\?|&&|process\.env/.test(element)) continue;
    findings.push({
      id: "inngest/cron-synced-early",
      severity: "manual",
      file: fn.file,
      line: fn.line,
      message: `${fn.name ?? "This cron function"} starts running as soon as the production app syncs with Inngest, so a deploy before the cutover runs it next to Gadget's scheduled action.`,
      fix: "Keep cron functions out of the served array until the cutover's Move scheduled work step, such as behind process.env.INNGEST_SCHEDULES, or check in the Inngest dashboard that production hasn't synced them yet.",
      docs: `${GUIDE}#cut-over-to-the-new-platform`,
    });
  }
  return findings;
}

function optionFindings(repo: Repo, fns: InngestFunction[]): Finding[] {
  const findings: Finding[] = [];
  for (const fn of fns) {
    const priority = fn.config.get("priority");
    if (priority) {
      const value = resolve(repo, fn.file, priority.value);
      const strings = [...value.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]).join(" ");
      if (/(^|[^\w.])-\s*\d/.test(strings)) {
        findings.push({
          id: "inngest/negative-priority",
          severity: "warning",
          file: fn.file,
          line: lineAt(fn.text, priority.index),
          message: "This priority expression can return a negative number. Inngest holds such a run back by that many seconds even when nothing else is waiting, and Gadget started a low job at once.",
          error: "a low job sent with -600 starts 10 minutes later on an empty queue",
          fix: "Return 600 for high, 300 for default, and 0 for low.",
          docs: `${GUIDE}#order-jobs-by-priority`,
        });
      }
    }
  }
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file) ?? "";
    if (!/inngest/.test(text)) continue;
    for (const m of text.matchAll(/scope\s*:\s*["']account["']/g)) {
      findings.push({
        id: "inngest/account-scope",
        severity: "warning",
        file,
        line: lineAt(text, m.index!),
        message: 'A concurrency limit with scope "account" counts runs in every Inngest environment, so a staging run can take a production slot.',
        fix: 'Use scope: "env" for a limit several functions share, with a prefix in the key such as \'"external-" + event.data.shopId\'.',
        docs: `${GUIDE}#set-up-development-and-deploys`,
      });
    }
  }
  return findings;
}

function maxRuntimeFindings(repo: Repo, fns: InngestFunction[]): Finding[] {
  if (fns.some((fn) => fn.config.has("checkpointing"))) return [];
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file) ?? "";
    for (const call of calls(text, "new\\s+Inngest")) {
      const open = nextToken(text, call.open + 1);
      if (text[open] === "{" && props(text, open).some((p) => p.key === "checkpointing")) return [];
    }
  }
  const clientFile = repo.sourceFiles().find((f) => /new\s+Inngest\s*\(/.test(repo.read(f) ?? ""));
  if (!clientFile) return [];
  const text = repo.read(clientFile) ?? "";
  return [
    {
      id: "inngest/max-runtime",
      severity: "warning",
      file: clientFile,
      line: lineOf(text, /new\s+Inngest\s*\(/),
      message: "Nothing sets checkpointing.maxRuntime, how long one request keeps starting steps. Version 4.26.2 of the package stops at 10 seconds and Inngest's docs say there is no limit, so the request length depends on the version installed, and a request that outlasts the host's timeout fails its step on every retry.",
      fix: 'Set checkpointing: { maxRuntime } on new Inngest(), below your host\'s request timeout minus your longest step, such as "4m" on Cloud Run\'s 5-minute default.',
      docs: `${GUIDE}#check-your-host-s-time-limits`,
    },
  ];
}

// Production config files that set INNGEST_DEV: the SDK then sends events to a Dev Server that isn't there.
function devFlagFindings(repo: Repo): Finding[] {
  const findings: Finding[] = [];
  const files = repo.find(/(^|\/)(Dockerfile[\w.-]*|fly(\.[\w-]+)?\.toml|render\.yaml|app\.yaml|service\.yaml|vercel\.json|railway\.(json|toml)|wrangler\.(toml|jsonc?)|\.env\.production)$/);
  for (const file of files) {
    const text = repo.read(file) ?? "";
    const m = /INNGEST_DEV["']?\s*[=:]\s*["']?(?:1|true|http)|key:\s*INNGEST_DEV\s*\n\s*value:\s*["']?(?:1|true|http)/.exec(text);
    if (!m) continue;
    findings.push({
      id: "inngest/dev-flag-in-config",
      severity: "error",
      file,
      line: lineAt(text, m.index),
      message: "This deploy config sets INNGEST_DEV, which points the inngest package at a local Dev Server. In production, every inngest.send fails and the serve endpoint skips signature checks.",
      error: "fetch failed (cause: connect ECONNREFUSED 127.0.0.1:8288)",
      fix: "Remove INNGEST_DEV from production config and set INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY instead. Set INNGEST_DEV=1 only in your local .env.",
      docs: `${GUIDE}#serve-the-endpoint`,
    });
  }
  return findings;
}

// A whole webhook payload sent as event data: the Dev Server accepts 3 MiB, the Free plan 256 KiB.
function payloadFindings(sent: SentEvent[]): Finding[] {
  const findings: Finding[] = [];
  for (const event of sent) {
    if (!event.data || !/authenticate\.webhook|request\.json\(\)/.test(event.text)) continue;
    const value = event.data.value;
    const whole = /^(payload|body)$/.test(value) || (event.text[event.data.valueIndex] === "{" && props(event.text, event.data.valueIndex).some((p) => /^(payload|body)$/.test(p.value) || (p.key === "..." && /^(payload|body)/.test(p.value.replace(/^\.\.\./, "")))));
    if (!whole) continue;
    findings.push({
      id: "inngest/large-payload",
      severity: "warning",
      file: event.file,
      line: lineAt(event.text, event.data.index),
      message: "This sends the whole webhook payload as event data. Inngest's Free plan rejects events over 256 KiB, and the Dev Server accepts up to 3 MiB, so a large order passes locally and fails in production.",
      error: "Inngest API Error: 400 Event is over the max size",
      fix: "Send the record's id and load the record inside a step.",
      docs: `${GUIDE}#map-api-enqueue-options-to-inngest`,
    });
  }
  return findings;
}

export const inngest: CheckModule = {
  platform: "inngest",
  title: "Inngest",
  detect: (repo) => "inngest" in repo.dependencies(),
  run: (repo) => {
    const clients = inngestClients(repo);
    const fns = functionsIn(repo, clients);
    const sent = sentEvents(repo, clients);
    return [
      ...notServedFindings(repo, fns),
      ...bigintFindings(sent),
      ...keyFieldFindings(repo, fns, sent),
      ...transactionFindings(repo, clients),
      ...outsideStepFindings(fns),
      ...cronFindings(repo, fns),
      ...optionFindings(repo, fns),
      ...maxRuntimeFindings(repo, fns),
      ...devFlagFindings(repo),
      ...payloadFindings(sent),
    ];
  },
};
