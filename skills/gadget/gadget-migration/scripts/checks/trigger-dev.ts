// Checks for apps moving to Trigger.dev. references/platforms/trigger-dev.md explains each one.
import { DOCS, type CheckModule, type Finding, type Repo } from "./types.ts";
import { lineAt, lineOf } from "./read-config.ts";
import { calls, closing, mask, props, transactionSpans, type Call, type Prop } from "./source-scan.ts";

const GUIDE = `${DOCS}/trigger-dev`;
const CONFIG = "trigger.config.ts";

interface TaskDef {
  file: string;
  text: string;
  name: string | null;
  id: string | null;
  line: number;
  scheduled: boolean;
  config: Map<string, Prop>;
}

interface Trigger {
  file: string;
  text: string;
  taskId: string | null;
  options: Map<string, Prop> | null;
  index: number;
}

const quoted = (value: string) => /^(["'`])([^"'`]*)\1$/.exec(value.trim())?.[2] ?? null;

// The top-level arguments of a call, as [start, end) spans.
function args(text: string, call: Call): [number, number][] {
  const out: [number, number][] = [];
  let start = call.open + 1;
  for (let i = start; i < call.close; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") i = closing(text, i);
    else if (c === '"' || c === "'" || c === "`") {
      const end = text.indexOf(c, i + 1);
      if (end > 0) i = end;
    } else if (c === ",") {
      out.push([start, i]);
      start = i + 1;
    }
    if (i < 0) break;
  }
  if (text.slice(start, call.close).trim()) out.push([start, call.close]);
  return out.map(([a, b]) => {
    while (a < b && /\s/.test(text[a])) a++;
    return [a, b];
  });
}

function tasksIn(repo: Repo): TaskDef[] {
  const out: TaskDef[] = [];
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file) ?? "";
    if (!/@trigger\.dev\/sdk/.test(text)) continue;
    for (const [callee, scheduled] of [["(?<![\\w.$])task", false], ["\\bschedules\\.task", true]] as const) {
      for (const call of calls(text, callee)) {
        const open = args(text, call)[0]?.[0];
        if (open === undefined || text[open] !== "{") continue;
        const config = new Map(props(text, open).map((p) => [p.key, p]));
        const before = text.slice(Math.max(0, call.index - 200), call.index);
        out.push({
          file,
          text,
          name: /(?:const|let|var)\s+([\w$]+)\s*=\s*$/.exec(before)?.[1] ?? null,
          id: quoted(config.get("id")?.value ?? ""),
          line: lineAt(text, call.index),
          scheduled,
          config,
        });
      }
    }
  }
  return out;
}

function triggersIn(repo: Repo, tasks: TaskDef[]): Trigger[] {
  const out: Trigger[] = [];
  const byName = new Map(tasks.filter((t) => t.name).map((t) => [t.name!, t]));
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file) ?? "";
    // tasks.trigger<typeof task>("id", payload, options)
    for (const call of calls(text, "\\btasks\\.trigger(?:AndPoll)?\\s*(?:<[^>()]*>)?")) {
      const a = args(text, call);
      const options = a[2] && text[a[2][0]] === "{" ? new Map(props(text, a[2][0]).map((p) => [p.key, p])) : null;
      out.push({ file, text, taskId: a[0] ? quoted(text.slice(...a[0])) : null, options, index: call.index });
    }
    // notifyExternalSystemTask.trigger(payload, options), for tasks defined in this app
    for (const name of byName.keys()) {
      for (const call of calls(text, `\\b${name.replace(/\$/g, "\\$")}\\.trigger`)) {
        const a = args(text, call);
        const options = a[1] && text[a[1][0]] === "{" ? new Map(props(text, a[1][0]).map((p) => [p.key, p])) : null;
        out.push({ file, text, taskId: byName.get(name)!.id, options, index: call.index });
      }
    }
  }
  return out;
}

// "1h30m" or "8d" in milliseconds, or null.
function duration(value: string): number | null {
  const s = quoted(value);
  if (!s || !/^(\d+[smhdw])+$/.test(s)) return null;
  const unit: Record<string, number> = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };
  return [...s.matchAll(/(\d+)([smhdw])/g)].reduce((total, m) => total + Number(m[1]) * unit[m[2]], 0);
}

function triggerFindings(tasks: TaskDef[], triggers: Trigger[]): Finding[] {
  const findings: Finding[] = [];
  const perKey = new Set(tasks.filter((t) => /perKey/.test(t.config.get("concurrency")?.value ?? "")).map((t) => t.id));
  for (const t of triggers) {
    const line = lineAt(t.text, t.index);
    const o = t.options;
    if (t.taskId && perKey.has(t.taskId) && !o?.has("concurrencyKey")) {
      findings.push({
        id: "trigger-dev/perkey-without-key",
        severity: "warning",
        file: t.file,
        line,
        message: `This triggers ${t.taskId}, whose concurrency is perKey, without a concurrencyKey. Runs without a key share one pool, so every store waits behind the busiest one.`,
        fix: "Pass the store's id as concurrencyKey on every trigger, such as { concurrencyKey: String(shopId) }.",
        docs: `${GUIDE}#limit-concurrency-per-store`,
      });
    }
    if (o?.has("idempotencyKey") && !o.has("idempotencyKeyTTL")) {
      findings.push({
        id: "trigger-dev/idempotency-ttl",
        severity: "warning",
        file: t.file,
        line: lineAt(t.text, o.get("idempotencyKey")!.index),
        message: "This idempotencyKey has no idempotencyKeyTTL, so a successful run blocks the same key for 30 days. Gadget freed an id 1 day after the job succeeded.",
        fix: 'Set idempotencyKeyTTL to the delay plus the run time plus a day, such as "1d" for a job that starts at once.',
        docs: `${GUIDE}#drop-duplicate-jobs`,
      });
    }
    const delay = o?.get("delay");
    const ttl = o?.get("idempotencyKeyTTL");
    if (delay && ttl && o?.has("idempotencyKey")) {
      const d = duration(delay.value);
      const k = duration(ttl.value);
      if (d !== null && k !== null && k <= d) {
        findings.push({
          id: "trigger-dev/ttl-shorter-than-delay",
          severity: "error",
          file: t.file,
          line: lineAt(t.text, ttl.index),
          message: `The idempotencyKeyTTL (${quoted(ttl.value)}) runs out before the delay (${quoted(delay.value)}) does. The TTL counts from the trigger, so a repeat trigger after it ends starts a second run while the first is still waiting.`,
          fix: "Make the TTL longer than the delay plus the run time, such as \"8d\" for a job delayed by a week.",
          docs: `${GUIDE}#drop-duplicate-jobs`,
        });
      }
    }
    const priority = o?.get("priority");
    if (priority && /^-\s*\d/.test(priority.value)) {
      findings.push({
        id: "trigger-dev/negative-priority",
        severity: "warning",
        file: t.file,
        line: lineAt(t.text, priority.index),
        message: "A negative priority holds the run back even when nothing else is waiting. A run triggered with -600 on an empty queue hadn't started 7 minutes later, and Gadget started a low job at once.",
        fix: "Pass 600 for high, 300 for default, and 0 for low.",
        docs: `${GUIDE}#order-jobs-by-priority`,
      });
    }
  }
  // the same task triggered with and without priority
  const ids = new Set(triggers.map((t) => t.taskId).filter(Boolean));
  for (const id of ids) {
    const group = triggers.filter((t) => t.taskId === id);
    if (!group.some((t) => t.options?.has("priority"))) continue;
    for (const t of group.filter((x) => !x.options?.has("priority"))) {
      findings.push({
        id: "trigger-dev/priority-mixed",
        severity: "warning",
        file: t.file,
        line: lineAt(t.text, t.index),
        message: `Other triggers of ${id} pass a priority and this one doesn't. A trigger without priority counts as 0, so this job runs after low jobs that pass 0 and every default job that passes 300.`,
        fix: "Pass a priority on every trigger: 600 for high, 300 for default, 0 for low.",
        docs: `${GUIDE}#order-jobs-by-priority`,
      });
    }
  }
  return findings;
}

function transactionFindings(repo: Repo, tasks: TaskDef[]): Finding[] {
  const findings: Finding[] = [];
  const names = tasks.map((t) => t.name).filter(Boolean) as string[];
  const callee = `\\b(?:tasks|batch|${["__none__", ...names].join("|")})\\.(?:trigger|batchTrigger)[\\w]*\\s*(?:<[^>()]*>)?`;
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file) ?? "";
    const spans = transactionSpans(text);
    if (!spans.length) continue;
    for (const call of calls(text, callee)) {
      if (!spans.some(([a, b]) => call.index > a && call.index < b)) continue;
      findings.push({
        id: "trigger-dev/trigger-in-transaction",
        severity: "error",
        file,
        line: lineAt(text, call.index),
        message: "This triggers a Trigger.dev task inside a database transaction. If the transaction rolls back, the run stays queued and runs for a write that never happened. Gadget only queued a background action when its transaction committed.",
        fix: "Trigger after the transaction's await, the way onSuccess ran after run.",
        docs: `${GUIDE}#trigger-tasks-from-your-server`,
      });
    }
  }
  return findings;
}

function taskFindings(tasks: TaskDef[]): Finding[] {
  const findings: Finding[] = [];
  for (const t of tasks) {
    const run = t.config.get("run")?.value ?? "";
    const client = /new\s+(PrismaClient|Pool)\s*\(/.exec(run);
    if (client) {
      findings.push({
        id: "trigger-dev/db-client-in-run",
        severity: "warning",
        file: t.file,
        line: lineAt(t.text, t.config.get("run")!.valueIndex + client.index),
        message: `This creates a ${client[1]} inside run, which opens a new connection pool on every run. With hundreds of runs at once, the database runs out of connections.`,
        error: "remaining connection slots are reserved for roles with the SUPERUSER attribute",
        fix: "Create the client once at the top of a module, with a pool of 1, and import it.",
        docs: `${GUIDE}#connect-to-your-database`,
      });
    }
    if (!t.scheduled) continue;
    const cron = t.config.get("cron");
    if (cron) {
      if (quoted(cron.value) !== null || !/\bwindow\s*:/.test(cron.value)) {
        findings.push({
          id: "trigger-dev/schedule-window",
          severity: "warning",
          file: t.file,
          line: lineAt(t.text, cron.index),
          message: "This schedule has no window, so Trigger.dev gives it a 60-minute one: each run starts at some point in the hour after its cron time. Gadget started a scheduled action within 10 seconds.",
          fix: 'Use cron: { pattern: "0 2 * * *", window: "0m" } if your plan allows it (https://trigger.dev/pricing), or the smallest window it allows.',
          docs: `${GUIDE}#replace-scheduled-actions`,
        });
      }
      findings.push({
        id: "trigger-dev/schedule-deployed-early",
        severity: "manual",
        file: t.file,
        line: lineAt(t.text, cron.index),
        message: "A declarative cron starts running as soon as a production deployment that contains it is live, so a deploy before the cutover runs it next to Gadget's scheduled action.",
        fix: "Leave cron off the task and attach the schedule with schedules.create at the cutover, as references/platforms/trigger-dev.md shows, or deploy this task only in the Move scheduled work step.",
        docs: `${GUIDE}#cut-over-to-the-new-platform`,
      });
    }
    if (!t.config.has("concurrency") && !t.config.has("queue")) {
      findings.push({
        id: "trigger-dev/schedule-overlap",
        severity: "warning",
        file: t.file,
        line: t.line,
        message: "This scheduled task has no concurrency limit, so a run that is still going when the next is due runs alongside it. Gadget skipped the new run.",
        fix: 'Add concurrency: { total: 1 }, and a ttl such as "1h" so a run that waits too long expires.',
        docs: `${GUIDE}#replace-scheduled-actions`,
      });
    }
  }
  const failing = tasks.find((t) => t.config.has("onFailure"));
  if (failing) {
    findings.push({
      id: "trigger-dev/on-failure-gaps",
      severity: "manual",
      file: failing.file,
      line: lineAt(failing.text, failing.config.get("onFailure")!.index),
      message: "onFailure runs after the last attempt fails, but not for runs that crash, fail with a system error, time out at maxDuration, or are canceled.",
      fix: "Set up alerts for those run statuses in the Trigger.dev dashboard as well.",
      docs: `${GUIDE}#make-jobs-safe-to-retry`,
    });
  }
  return findings;
}

function namedLimitFindings(repo: Repo, tasks: TaskDef[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file) ?? "";
    for (const m of text.matchAll(/(?:const|let)\s+([\w$]+)\s*=\s*concurrencyLimit\s*\(/g)) {
      const users = tasks.filter((t) => new RegExp(`\\b${m[1]}\\b`).test(t.config.get("concurrency")?.value ?? ""));
      if (users.length < 2) continue;
      findings.push({
        id: "trigger-dev/named-limit",
        severity: "warning",
        file,
        line: lineAt(text, m.index!),
        message: `${m[1]} is a named concurrencyLimit shared by ${users.length} tasks. On self-hosted Trigger.dev 4.8.3, two tasks sharing a named limit of 2 ran 8 jobs for one store at once.`,
        fix: "Share a queue({ name, concurrencyLimit }) between the tasks and pass the store's id as concurrencyKey, or check that the named limit holds in your environment before you rely on it.",
        docs: `${GUIDE}#share-a-limit-between-tasks`,
      });
    }
  }
  return findings;
}

// The directories trigger.config.ts lists in dirs, without "./" or a trailing slash.
function configDirs(config: string | null): string[] {
  return config ? [...(config.match(/dirs\s*:\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/["'`]\.?\/?([^"'`]+?)\/?["'`]/g)].map((m) => m[1]) : [];
}

const RELATIVE_IMPORT = /(?:import|export)\s+(?!type\b)[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']/g;

// The repo file a relative import names, or null when it isn't in the repo.
function resolveRelative(repo: Repo, from: string, specifier: string): string | null {
  const base = new URL(specifier, `file:///${from}`).pathname.slice(1).replace(/\.(js|mjs)$/, "");
  return [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`].find((c) => repo.exists(c)) ?? null;
}

// Files the tasks run: everything under the config's dirs, and the files they import, a few levels deep.
function taskFiles(repo: Repo, config: string | null): string[] {
  const dirs = configDirs(config);
  const roots = repo.sourceFiles().filter((f) => (dirs.length ? dirs.some((d) => f.startsWith(`${d}/`)) : /(^|\/)trigger\//.test(f)));
  const seen = new Set<string>();
  const queue = roots.map((f) => ({ file: f, depth: 0 }));
  while (queue.length) {
    const { file, depth } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (depth >= 3) continue;
    const text = repo.read(file) ?? "";
    for (const m of text.matchAll(RELATIVE_IMPORT)) {
      const found = resolveRelative(repo, file, m[1]);
      if (found) queue.push({ file: found, depth: depth + 1 });
    }
  }
  return [...seen];
}

// Calls to the Shopify Admin API. SHOPIFY_CALL runs on the text with comments and strings blanked;
// SHOPIFY_STRING and SHOPIFY_IMPORT run with only comments blanked, since a URL, a header, and a
// package name are strings.
const SHOPIFY_CALL = /\badmin\.(?:graphql\s*\(|rest\.)|\bunauthenticated\.admin\s*\(|\bshopify\.clients\.(?:Graphql|Rest)\b|\bnew\s+GraphqlClient\b|\bcreateAdmin(?:Rest)?ApiClient\s*\(/;
const SHOPIFY_STRING = /\.myshopify\.com\/admin\/api\b|\/admin\/api\/(?:20\d\d-\d\d|unstable|\$\{)|x-shopify-access-token/i;
const SHOPIFY_IMPORT = /(?<![\w$.])(?:import\s+(?!type\b)[^;"'`]*?from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["'](?:@shopify\/shopify-api|@shopify\/admin-api-client|shopify-api-node)(?:\/[^"']*)?["']/;

// The index of the file's first call to the Shopify Admin API, or null.
function shopifyCallIndex(text: string): number | null {
  const noComments = mask(text, false);
  const hits = [SHOPIFY_CALL.exec(mask(text))?.index, SHOPIFY_STRING.exec(noComments)?.index, SHOPIFY_IMPORT.exec(noComments)?.index].filter((i): i is number => i !== undefined);
  return hits.length ? Math.min(...hits) : null;
}

// Task files that call Shopify, directly or through a module they import. The IP allowlist lives in
// Shopify's dashboard, so the script can only say which files to look at.
function shopifyFromTaskFindings(repo: Repo, tasks: TaskDef[]): Finding[] {
  const findings: Finding[] = [];
  const dirs = configDirs(repo.read(CONFIG));
  const roots = new Set([...repo.sourceFiles().filter((f) => dirs.some((d) => f.startsWith(`${d}/`))), ...tasks.map((t) => t.file)]);
  for (const file of [...roots].sort()) {
    const text = repo.read(file) ?? "";
    const hits: { index: number; via?: string }[] = [];
    const direct = shopifyCallIndex(text);
    if (direct !== null) hits.push({ index: direct });
    for (const m of mask(text, false).matchAll(RELATIVE_IMPORT)) {
      const imported = resolveRelative(repo, file, m[1]);
      if (imported && shopifyCallIndex(repo.read(imported) ?? "") !== null) hits.push({ index: m.index!, via: imported });
    }
    if (!hits.length) continue;
    const first = hits.reduce((a, b) => (b.index < a.index ? b : a));
    findings.push({
      id: "trigger-dev/shopify-from-tasks",
      severity: "manual",
      file,
      line: lineAt(text, first.index),
      message: `This task file calls the Shopify Admin API${first.via ? ` through ${first.via}` : ""}. Tasks run on Trigger.dev's machines, so the addresses or ASN you add to Shopify's IP allowlist for your host don't cover these calls, and Shopify answers them with 403 once the allowlist is enforced.`,
      error: "403",
      fix: 'Add the static addresses on the Trigger.dev dashboard\'s Regions page to the allowlist as addresses next to your host\'s entries before you turn on enforcement. With no static addresses, add the ASN and country Trigger.dev confirms your tasks call from. Run Shopify\'s allowlist test again after the tasks make their first calls.',
      docs: `${GUIDE}#call-shopify-from-your-tasks`,
    });
  }
  return findings;
}

// CLI commands that don't stop on a version mismatch, so trigger.dev@latest is fine for them
const HARMLESS_COMMANDS = new Set(["dev", "init", "login", "logout", "whoami", "update", "list-profiles", "switch", "mcp", "install-mcp"]);

type Version = [number, number, number];
const MIN_SDK: Version = [4, 7, 0];
const parseVersion = (v: string): Version | null => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const compare = (a: Version, b: Version) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// The version of a package that the committed lockfile installs, and the lockfile it's in.
function lockedVersion(repo: Repo, name: string, spec: string): { version: string; file: string } | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const npm = repo.read("package-lock.json");
  if (npm) {
    try {
      const lock = JSON.parse(npm);
      const version = lock.packages?.[`node_modules/${name}`]?.version ?? lock.dependencies?.[name]?.version;
      if (typeof version === "string") return { version, file: "package-lock.json" };
    } catch {
      // an unreadable lockfile says nothing
    }
  }
  const pnpm = repo.read("pnpm-lock.yaml");
  if (pnpm) {
    // importers: { .: { dependencies: { '@trigger.dev/sdk': { specifier: ^4.6.0, version: 4.8.3 } } } }, or a packages key
    const importer = new RegExp(`^[ \\t]+['"]?${esc}['"]?:[ \\t]*\\n[ \\t]+specifier:[^\\n]*\\n[ \\t]+version:[ \\t]*['"]?(\\d+\\.\\d+\\.\\d+)`, "m").exec(pnpm);
    const key = new RegExp(`^[ \\t]+['"]?/?${esc}[@/](\\d+\\.\\d+\\.\\d+)`, "m").exec(pnpm);
    const version = importer?.[1] ?? key?.[1];
    if (version) return { version, file: "pnpm-lock.yaml" };
  }
  const yarn = repo.read("yarn.lock");
  if (yarn) {
    // "@trigger.dev/sdk@^4.6.0": then version "4.8.3" (classic) or version: 4.8.3 (Berry)
    const entries = [...yarn.matchAll(new RegExp(`^"?${esc}@([^\\n]*):[ \\t]*\\n(?:[ \\t]+[^\\n]*\\n)*?[ \\t]+version:?[ \\t]+"?(\\d+\\.\\d+\\.\\d+)`, "gm"))];
    const entry = entries.find((e) => e[1].includes(spec)) ?? entries[0];
    if (entry) return { version: entry[2], file: "yarn.lock" };
  }
  const bun = repo.read("bun.lock");
  const version = bun ? new RegExp(`"${esc}@(\\d+\\.\\d+\\.\\d+)"`).exec(bun)?.[1] : undefined;
  if (version) return { version, file: "bun.lock" };
  return null;
}

// The lowest version a range such as ^3.3.0, ~4.6.0, or 4.6.x can't reach, or null when it has no ceiling.
function ceiling(spec: string): Version | null {
  const m = /^([\^~])?\s*(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(spec.trim());
  if (!m) return null;
  const [, op, major, minor, patch] = m;
  const x = (s?: string) => s === undefined || s === "x" || s === "*";
  if (op === "^") return Number(major) > 0 || x(minor) ? [Number(major) + 1, 0, 0] : [0, Number(minor) + 1, 0];
  if (x(minor)) return [Number(major) + 1, 0, 0];
  if (op === "~" || x(patch)) return [Number(major), Number(minor) + 1, 0];
  return null;
}

// Why the SDK that installs is older than 4.7.0, which concurrency needs, or null when it isn't or the
// script can't tell. A range like ^4.6.0 with no lockfile installs the newest 4.x, so it passes.
function sdkTooOld(repo: Repo, spec: string): string | null {
  const locked = lockedVersion(repo, "@trigger.dev/sdk", spec);
  if (locked) {
    const v = parseVersion(locked.version);
    return v && compare(v, MIN_SDK) < 0 ? `${locked.file} installs ${locked.version}` : null;
  }
  if (/^\d+\.\d+\.\d+$/.test(spec.trim())) return compare(parseVersion(spec)!, MIN_SDK) < 0 ? `package.json pins ${spec}` : null;
  const top = ceiling(spec);
  return top && compare(top, MIN_SDK) <= 0 ? `package.json's ${spec} only allows versions below 4.7.0` : null;
}

function configFindings(repo: Repo, tasks: TaskDef[]): Finding[] {
  const findings: Finding[] = [];
  const config = repo.read(CONFIG);
  const deps = repo.dependencies();
  if (config) {
    const at = lineOf(config, /defineConfig\s*\(/) ?? 1;
    if (!/\bmaxDuration\s*:/.test(config)) {
      findings.push({
        id: "trigger-dev/max-duration",
        severity: "warning",
        file: CONFIG,
        line: at,
        message: "trigger.config.ts sets no maxDuration. Its type requires one and Trigger.dev's docs say to set it, but the deploy builds without typechecking.",
        error: "Property 'maxDuration' is missing in type",
        fix: "Set maxDuration above your longest action, such as 900 for Gadget's 15-minute maximum.",
        docs: `${GUIDE}#check-your-host-s-time-limits`,
      });
    }
    if (!/\bretries\s*:/.test(config)) {
      findings.push({
        id: "trigger-dev/default-retries",
        severity: "warning",
        file: CONFIG,
        line: at,
        message: "trigger.config.ts sets no retries, so a task without its own retry setting gets 3 attempts. Gadget made 7: the first plus 6 retries.",
        fix: "Add retries: { default: { maxAttempts: 7, factor: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 60_000, randomize: false } }.",
        docs: `${GUIDE}#configure-the-project`,
      });
    }
    const files = taskFiles(repo, config);
    const usesPrisma = files.some((f) => /from\s+["']@prisma\/client["']|new\s+PrismaClient\s*\(/.test(repo.read(f) ?? ""));
    if (usesPrisma && !/prismaExtension\s*\(/.test(config)) {
      findings.push({
        id: "trigger-dev/prisma-extension",
        severity: "error",
        file: CONFIG,
        line: at,
        message: "Your tasks use Prisma, and the build has no prismaExtension, so the image Trigger.dev deploys has no generated Prisma client.",
        error: "@prisma/client did not initialize yet",
        fix: 'Add prismaExtension({ mode: "legacy", schema: "prisma/schema.prisma" }) from @trigger.dev/build/extensions/prisma to build.extensions.',
        docs: `${GUIDE}#configure-the-project`,
      });
    }
    const names = new Set<string>();
    for (const f of files) for (const m of (repo.read(f) ?? "").matchAll(/process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\])/g)) names.add(m[1] ?? m[2]);
    const needed = [...names].filter((n) => !/^(TRIGGER_|NODE_ENV$)/.test(n)).sort();
    if (needed.length) {
      findings.push({
        id: "trigger-dev/env-vars",
        severity: "manual",
        file: CONFIG,
        line: at,
        message: `Your tasks read ${needed.join(", ")}. Tasks run on Trigger.dev's machines and don't see your host's variables, so a missing one fails every attempt.`,
        fix: `Add them to each Trigger.dev environment, or sync them with syncEnvVars, then check with scripts/check-trigger-env.ts prod ${needed.join(" ")}.`,
        docs: `${GUIDE}#deploy-tasks`,
      });
    }
  }
  // versions: the CLI aborts a deploy unless every @trigger.dev package matches it exactly
  const pkg = repo.read("package.json") ?? "";
  const versions = Object.entries(deps).filter(([name]) => name.startsWith("@trigger.dev/") || name === "trigger.dev");
  const exact = versions.filter(([, v]) => /^\d+\.\d+\.\d+$/.test(v));
  const ranged = versions.filter(([, v]) => !/^\d+\.\d+\.\d+$/.test(v));
  if (new Set(exact.map(([, v]) => v)).size > 1) {
    findings.push({
      id: "trigger-dev/version-mismatch",
      severity: "error",
      file: "package.json",
      line: lineOf(pkg, `"${exact[1][0]}"`),
      message: `The Trigger.dev packages are at different versions (${exact.map(([n, v]) => `${n}@${v}`).join(", ")}), and the CLI refuses to deploy unless every @trigger.dev package matches its own version.`,
      error: "ERROR: Version mismatch detected while running in CI. This won't end well. Aborting.",
      fix: "Pin every @trigger.dev package and the trigger.dev CLI to the same exact version.",
      docs: `${GUIDE}#deploy-tasks`,
    });
  } else if (ranged.length) {
    findings.push({
      id: "trigger-dev/version-mismatch",
      severity: "warning",
      file: "package.json",
      line: lineOf(pkg, `"${ranged[0][0]}"`),
      message: `${ranged.map(([n, v]) => `${n} ${v}`).join(", ")} can install a different version from the other Trigger.dev packages, and the CLI refuses to deploy unless every @trigger.dev package matches its own version.`,
      fix: "Pin every @trigger.dev package and the trigger.dev CLI to the same exact version, without ^ or ~.",
      docs: `${GUIDE}#deploy-tasks`,
    });
  }
  const spec = deps["@trigger.dev/sdk"];
  const old = spec ? sdkTooOld(repo, spec) : null;
  if (old) {
    for (const t of tasks.filter((x) => x.config.has("concurrency"))) {
      findings.push({
        id: "trigger-dev/sdk-version",
        severity: "error",
        file: t.file,
        line: lineAt(t.text, t.config.get("concurrency")!.index),
        message: `The concurrency option needs @trigger.dev/sdk 4.7.0 or later, and ${old}.`,
        fix: "Upgrade @trigger.dev/sdk, @trigger.dev/build, and the CLI together to 4.7.0 or later.",
        docs: `${GUIDE}#define-a-task`,
      });
    }
  }
  // `npx trigger.dev@latest deploy` aborts as soon as a CLI newer than the pinned packages ships. Other
  // commands, such as the guide's `npx trigger.dev@latest dev`, don't stop on a version mismatch.
  const places = repo.find(/(^|\/)(package\.json|Dockerfile[\w.-]*|Makefile|[\w.-]+\.sh|\.gitlab-ci\.yml|bitbucket-pipelines\.yml|\.github\/workflows\/[\w.-]+\.ya?ml)$/).filter((f) => !f.includes("node_modules"));
  const pinned = spec?.replace(/^[\^~]/, "") ?? "4.8.3";
  for (const file of places) {
    const text = repo.read(file) ?? "";
    for (const m of text.matchAll(/trigger\.dev@(latest|beta|next)\b/g)) {
      const command = /^[ \t]+([a-z][\w-]*)/.exec(text.slice(m.index! + m[0].length))?.[1];
      if (command && HARMLESS_COMMANDS.has(command)) continue;
      // a CI workflow or script that installs the latest CLI and deploys with it, as in
      // npm install -g trigger.dev@latest, then trigger.dev deploy. In package.json, only within one script.
      const lineEnd = text.indexOf("\n", m.index!);
      const line = text.slice(text.lastIndexOf("\n", m.index!) + 1, lineEnd < 0 ? text.length : lineEnd);
      const deploys = command === "deploy" || /\btrigger\.dev(?:@[\w.-]+)?\s+deploy\b/.test(file.endsWith("package.json") ? line : text);
      findings.push({
        id: "trigger-dev/cli-latest",
        severity: deploys ? "error" : "warning",
        file,
        line: lineAt(text, m.index!),
        message: deploys
          ? `This deploys with trigger.dev@${m[1]}, which moves to each new CLI release. The CLI refuses to deploy when your @trigger.dev packages are a different version, so deploys start failing the day a new CLI ships.`
          : `This runs trigger.dev@${m[1]}${command ? ` ${command}` : ""}, which moves to each new CLI release. If it deploys, the deploy starts failing the day a new CLI ships, because the CLI refuses to deploy when your @trigger.dev packages are a different version.`,
        error: "ERROR: Version mismatch detected while running in CI. This won't end well. Aborting.",
        fix: `Run the version your packages pin, such as npx trigger.dev@${pinned} deploy, or add trigger.dev to devDependencies at that version and run npx trigger.dev deploy.`,
        docs: `${GUIDE}#deploy-tasks`,
      });
    }
  }
  return findings;
}

export const triggerDev: CheckModule = {
  platform: "trigger-dev",
  title: "Trigger.dev",
  detect: (repo) => repo.exists(CONFIG) || "@trigger.dev/sdk" in repo.dependencies(),
  run: (repo) => {
    const tasks = tasksIn(repo);
    const triggers = triggersIn(repo, tasks);
    return [...configFindings(repo, tasks), ...triggerFindings(tasks, triggers), ...transactionFindings(repo, tasks), ...taskFindings(tasks), ...namedLimitFindings(repo, tasks), ...shopifyFromTaskFindings(repo, tasks)];
  },
};
