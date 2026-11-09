#!/usr/bin/env node
// Lists everything in a Gadget app that a move to another platform has to replace.
//
// Usage, from a directory created by `ggt pull` (Node 22.18+ or 23.6+, no dependencies):
//   node path/to/inventory.ts . > MIGRATION_INVENTORY.md
//
// It reads files only. Model schemas are loaded by stripping their TypeScript types; action,
// route, and frontend files are scanned as text, so treat the counts as a checklist to confirm,
// not as a parse of your code.

import { readdir, readFile } from "node:fs/promises";
import * as nodeModule from "node:module";
import { join, relative, sep } from "node:path";

const root = process.argv[2] ?? ".";
// stripTypeScriptTypes prints an ExperimentalWarning on every Node version that has it
process.removeAllListeners("warning");
const SKIP_DIRS = new Set(["node_modules", ".gadget", ".git", "build", "dist", ".react-router", ".cache"]);

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...(await walk(join(dir, entry.name))));
    } else {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

const files = (await walk(root)).map((file) => relative(root, file).split(sep).join("/"));
const read = (file: string) => readFile(join(root, file), "utf8");
const isCode = (file: string) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file);

// Returns the text of the balanced (...) or {...} starting at `open`, ignoring brackets inside strings
// and comments. Regex literals aren't recognized, so a quote inside one can throw it off.
function balanced(text: string, open: number): string {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
    } else if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else if (char === '"' || char === "'" || char === "`") quote = char;
    else if (pairs[char]) stack.push(pairs[char]);
    else if (char === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

function objectAfter(text: string, pattern: RegExp): string | null {
  const match = pattern.exec(text);
  if (!match) return null;
  const open = text.indexOf("{", match.index + match[0].length - 1);
  return open === -1 ? null : balanced(text, open);
}

// Loads a metadata file such as schema.gadget.ts or permissions.gadget.ts and returns one export.
// These files normally import only types, which stripping removes. Any other import is dropped.
async function loadExport(file: string, name: string): Promise<any> {
  let source = await read(file);
  const strip = (nodeModule as any).stripTypeScriptTypes;
  if (file.endsWith(".ts") && typeof strip === "function") source = strip(source);
  else if (file.endsWith(".ts")) source = source.replace(/:\s*Gadget\w+\b/g, "");
  source = source.replace(/^\s*import\b[^"'`]*?\bfrom\s*["'][^"']+["'];?/gm, "").replace(/^\s*import\s*["'][^"']+["'];?/gm, "");
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  if (!module[name] || typeof module[name] !== "object") throw new Error(`no \`${name}\` export found`);
  return module[name];
}

const out: string[] = [];
const say = (line = "") => out.push(line);
const list = (items: string[]) => (items.length ? items.map((item) => `- ${item}`).forEach((line) => say(line)) : say("- none found"));

// ---------------------------------------------------------------- settings and Shopify config
const settingsFile = files.find((file) => /^settings\.gadget\.(ts|js)$/.test(file));
const settings = settingsFile ? await read(settingsFile) : "";
const tomlFiles = files.filter((file) => /^shopify\.app(\.[\w-]+)?\.toml$/.test(file));

say(`# Migration inventory`);
say();
say(`Generated from \`${root}\` by the gadget-migration skill. Each section names the reference that covers it.`);
say();
say(`## App settings`);
say();
list(
  [
    settings.match(/frameworkVersion:\s*"([^"]+)"/)?.[1] && `Framework version: \`${settings.match(/frameworkVersion:\s*"([^"]+)"/)![1]}\``,
    settings.match(/apiVersion:\s*"([^"]+)"/)?.[1] && `Shopify API version: \`${settings.match(/apiVersion:\s*"([^"]+)"/)![1]}\``,
    /shopify\s*:/.test(settings) && "Shopify connection (see references/shopify-tokens.md and references/shopify-webhooks.md)",
    /emailPassword/.test(settings) && "Email and password sign-in (see references/users-and-auth.md)",
    /google\s*:/.test(settings) && "Google sign-in (see references/users-and-auth.md)",
    /bigcommerce\s*:/i.test(settings) && "BigCommerce connection (not covered by this skill)",
    /openai\s*:/i.test(settings) && "OpenAI connection: move its API key to your new host",
    ...tomlFiles.map((file) => `Shopify app config: \`${file}\``),
  ].filter(Boolean) as string[]
);
say();

for (const file of tomlFiles) {
  const toml = await read(file);
  const topics = [...toml.matchAll(/(?<![\w])topics\s*=\s*\[([^\]]*)\]/g)].flatMap((match) => [...match[1].matchAll(/"([^"]+)"/g)].map((topic) => topic[1]));
  const compliance = [...toml.matchAll(/compliance_topics\s*=\s*\[([^\]]*)\]/g)].flatMap((match) => [...match[1].matchAll(/"([^"]+)"/g)].map((topic) => topic[1]));
  const uris = [...new Set([...toml.matchAll(/uri\s*=\s*"([^"]+)"/g)].map((match) => match[1]))];
  say(`### \`${file}\``);
  say();
  list(
    [
      `Webhook topics (${topics.length}): ${topics.map((topic) => `\`${topic}\``).join(", ") || "none"}`,
      compliance.length ? `Compliance topics: ${compliance.map((topic) => `\`${topic}\``).join(", ")}` : "",
      uris.length ? `Webhook URIs to change at cutover: ${uris.map((uri) => `\`${uri}\``).join(", ")}` : "",
      /include_fields/.test(toml) ? "Some subscriptions use `include_fields`: keep `updated_at` in each list" : "",
      /\[app_proxy\]/.test(toml) ? "App proxy configured: change its `url` at cutover (see references/shopify-signatures.md)" : "",
      toml.match(/application_url\s*=\s*"([^"]+)"/) ? `application_url: \`${toml.match(/application_url\s*=\s*"([^"]+)"/)![1]}\`` : "",
      toml.match(/scopes\s*=\s*"([^"]*)"/) ? `Access scopes: \`${toml.match(/scopes\s*=\s*"([^"]*)"/)![1]}\`` : "",
    ].filter(Boolean)
  );
  say();
}

// ---------------------------------------------------------------- models
const NEEDS_CARE: Record<string, string> = {
  password: "bcrypt hash: import into a sign-in provider (references/users-and-auth.md)",
  encryptedString: "decrypted on read: re-encrypt on the new platform (references/data-export.md)",
  file: "download each file from its URL; private URLs expire (references/data-export.md)",
  computed: "Gelly: rewrite as a SQL view or query (references/schema-mapping.md)",
  vector: "pgvector column: check dimensions and indexes (references/schema-mapping.md)",
  roleList: "role keys: rebuild your permission checks (references/shop-tenancy.md)",
  money: "store as numeric plus the currency code (references/schema-mapping.md)",
  recordState: "legacy state machine field: store the state name as text",
};

const schemaFiles = files.filter((file) => /^api\/models\/.+\/schema\.gadget\.(ts|js)$/.test(file)).sort();
const modelNames: string[] = [];
const shopifyModels = new Set<string>();
const careLines: string[] = [];
const relationshipLines: string[] = [];

say(`## Models (${schemaFiles.length})`);
say();
say(`Each model becomes a table. See references/schema-mapping.md for column types and references/data-export.md for getting the records out.`);
say();
say(`| Model | Kind | Stored fields | Notes |`);
say(`|---|---|---|---|`);
for (const file of schemaFiles) {
  const model = file.replace(/^api\/models\//, "").replace(/\/schema\.gadget\.(ts|js)$/, "");
  modelNames.push(model);
  let schema: any;
  try {
    schema = await loadExport(file, "schema");
  } catch (error) {
    say(`| \`${model}\` | ? | ? | could not load: ${(error as Error).message.split("\n")[0]} |`);
    continue;
  }
  const fields = Object.entries<any>(schema?.fields ?? {});
  const shopifyFields: string[] = schema?.shopify?.fields ?? [];
  const isShopify = Boolean(schema?.shopify) || /^shopify[A-Z]/.test(model);
  if (isShopify) shopifyModels.add(model);
  const counts = new Map<string, number>();
  for (const [name, field] of fields) {
    counts.set(field.type, (counts.get(field.type) ?? 0) + 1);
    if (NEEDS_CARE[field.type]) careLines.push(`\`${model}.${name}\` (${field.type}): ${NEEDS_CARE[field.type]}`);
    if (field.type === "belongsTo") relationshipLines.push(`\`${model}.${name}\` belongs to \`${field.parent?.model}\``);
    if (field.type === "hasManyThrough") relationshipLines.push(`\`${model}.${name}\` has many \`${field.sibling?.model}\` through \`${field.join?.model}\``);
    if (field.type === "enum" && field.acceptMultipleSelections) careLines.push(`\`${model}.${name}\` (enum, multiple values): use \`text[]\``);
    if (field.validations?.unique) careLines.push(`\`${model}.${name}\` is unique${field.validations.unique?.scopeByField ? ` per \`${field.validations.unique.scopeByField}\`` : ""}: add a unique index`);
  }
  const summary = [...counts].map(([type, count]) => `${count} ${type}`).join(", ");
  const kind = isShopify ? "Shopify" : "custom";
  const notes = isShopify ? `${shopifyFields.length} synced Shopify fields: backfill from Shopify instead of exporting them` : "export from production";
  say(`| \`${model}\` | ${kind} | ${summary || "none"} | ${notes} |`);
}
say();
if (careLines.length) {
  say(`### Fields that need extra steps`);
  say();
  list(careLines);
  say();
}
if (relationshipLines.length) {
  say(`### Relationships (keep every record id so these keep pointing at the right rows)`);
  say();
  list(relationshipLines);
  say();
}

// ---------------------------------------------------------------- actions
const actionFiles = files.filter((file) => /^api\/(models\/.+\/actions|actions)\/.+\.(ts|js)$/.test(file) && !/\.(test|spec)\./.test(file)).sort();
const enqueueLines: string[] = [];
const scheduledLines: string[] = [];
const webhookActionLines: string[] = [];
const actionRows: string[] = [];

for (const file of actionFiles) {
  const text = await read(file);
  const name = file.replace(/^api\//, "").replace(/\.(ts|js)$/, "");
  const options = objectAfter(text, /export\s+const\s+options\b[^=]*=\s*/) ?? "";
  const triggers = objectAfter(options, /triggers\s*:\s*/) ?? "";
  const traits: string[] = [];

  if (/api\s*:\s*false/.test(triggers)) traits.push("not callable from the API");
  const schedulerMatch = /scheduler\s*:\s*([[{])/.exec(triggers);
  const schedule = schedulerMatch ? balanced(triggers, schedulerMatch.index + schedulerMatch[0].length - 1) : "";
  if (schedule) {
    traits.push("scheduled");
    scheduledLines.push(`\`${name}\`: \`${schedule.replace(/\s+/g, " ")}\``);
  }
  const webhookTopics = [...(objectAfter(triggers, /shopify\s*:\s*/) ?? "").matchAll(/"([a-z_]+\/[a-z_]+)"/g)].map((match) => match[1]);
  const actionModel = file.match(/^api\/models\/(.+)\/actions\/(\w+)\.(ts|js)$/);
  const isShopifyRecordAction = Boolean(actionModel && shopifyModels.has(actionModel[1]) && ["create", "update", "delete"].includes(actionModel[2]));
  if (webhookTopics.length) {
    traits.push(`webhooks: ${webhookTopics.join(", ")}`);
    webhookActionLines.push(`\`${name}\`: ${webhookTopics.map((topic) => `\`${topic}\``).join(", ")}`);
  } else if (/shopify\s*:/.test(triggers) || isShopifyRecordAction) {
    traits.push("runs for Shopify webhooks, syncs, and reconciliation");
    webhookActionLines.push(`\`${name}\`: topics come from \`shopify.app.toml\` or the Shopify connection settings`);
  }
  if (/transactional\s*:\s*false/.test(options)) traits.push("transactional: false");
  const timeout = options.match(/timeoutMS\s*:\s*([\d_]+)/);
  if (timeout) traits.push(`timeoutMS ${timeout[1]}`);
  if (/connections\.shopify/.test(text)) traits.push("calls Shopify");
  if (/\.changed\(/.test(text)) traits.push("checks record.changed");
  if (/preventCrossShopDataAccess/.test(text)) traits.push("shop tenancy check");
  if (/\btrigger\??\.type\b/.test(text)) traits.push("branches on trigger.type");
  if (/\bemails\.(sendMail|setTransport)/.test(text)) traits.push("sends email");
  if (/export\s+const\s+onSuccess\b/.test(text)) traits.push("has onSuccess");

  let index = text.indexOf("api.enqueue(");
  while (index !== -1) {
    const call = balanced(text, index + "api.enqueue".length).replace(/\s+/g, " ");
    const target = call.match(/^\(\s*([\w.]+)/)?.[1] ?? "?";
    const found = ["queue", "maxConcurrency", "retries", "priority", "startAt", "id", "onDuplicateID"].filter((key) => new RegExp(`\\b${key}\\s*:`).test(call));
    enqueueLines.push(`\`${name}\` enqueues \`${target}\`${found.length ? ` with ${found.map((key) => `\`${key}\``).join(", ")}` : " with default options"}`);
    index = text.indexOf("api.enqueue(", index + 1);
  }
  actionRows.push(`| \`${name}\` | ${traits.join("; ") || "API only"} |`);
}

say(`## Actions (${actionFiles.length})`);
say();
say(`Each action becomes a function. Database writes in \`run\` go in one transaction; work in \`onSuccess\` runs after it commits (references/actions-and-transactions.md).`);
say();
say(`| Action | What to carry over |`);
say(`|---|---|`);
actionRows.forEach((row) => say(row));
say();
say(`### Background jobs (references/background-jobs.md)`);
say();
list(enqueueLines);
say();
say(`### Scheduled actions (references/background-jobs.md)`);
say();
list(scheduledLines);
say();
say(`### Actions triggered by Shopify webhooks (references/shopify-webhooks.md)`);
say();
list(webhookActionLines);
say();

// ---------------------------------------------------------------- routes and access control
// file names follow Gadget's routing rules: GET.ts is the folder's root, GET-[id].ts captures a
// parameter, GET-[...].ts is a wildcard, and +scope.ts files are Fastify route plugins
const ROUTE_FILE = /^api\/routes\/((?:[^/]+\/)*)(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|ANY)(?:-([^/]+))?\.(ts|js)$/;
const routeFiles = files.filter((file) => ROUTE_FILE.test(file)).sort();
const routePlugins = files.filter((file) => /^api\/routes\/(.+\/)?\+[^/]+\.(ts|js)$/.test(file)).sort();
say(`## HTTP routes (${routeFiles.length})`);
say();
say(`Gadget route handlers are Fastify handlers, so on a Fastify server most of them move with small changes.`);
say();
list([
  ...routeFiles.map((file) => {
    const [, dirs, method, rest] = file.match(ROUTE_FILE)!;
    const path = `/${dirs}${rest ?? ""}`.replace(/\[\.\.\.\]/g, "*").replace(/\[(\w+)\]/g, ":$1").replace(/\/$/, "") || "/";
    return `\`${method} ${path}\` from \`${file}\``;
  }),
  ...routePlugins.map((file) => `Route plugin \`${file}\`: re-register its hooks or Fastify plugins on the new server`),
]);
say();

const permissionsFile = files.find((file) => /^accessControl\/permissions\.gadget\.(ts|js)$/.test(file));
const filterFiles = files.filter((file) => /^accessControl\/filters\/.+\.gelly$/.test(file)).sort();
say(`## Access control (references/shop-tenancy.md)`);
say();
if (permissionsFile) {
  let roleLine: string;
  try {
    const roleNames = Object.keys((await loadExport(permissionsFile, "permissions")).roles ?? {});
    roleLine = `Roles: ${roleNames.map((role) => `\`${role}\``).join(", ") || "none found"}`;
  } catch (error) {
    roleLine = `Could not load \`${permissionsFile}\`: ${(error as Error).message.split("\n")[0]}`;
  }
  list([roleLine, ...filterFiles.map((file) => `Gelly filter: \`${file}\``)]);
} else {
  list([]);
}
say();

// ---------------------------------------------------------------- frontend
const HOOKS = ["useFindMany", "useFindOne", "useFindFirst", "useFindBy", "useMaybeFindOne", "useMaybeFindFirst", "useGet", "useAction", "useGlobalAction", "useBulkAction", "useActionForm", "useList", "useTable", "useUser", "useSession", "useAuth", "useSignOut", "SignedIn", "SignedOut", "SignedInOrRedirect", "SignedOutOrRedirect", "AutoTable", "AutoForm", "useEnqueue"];
// apps created before the web/ layout keep their frontend in frontend/
const webFiles = files.filter((file) => (file.startsWith("web/") || file.startsWith("frontend/")) && isCode(file));
const hookCounts = new Map<string, number>();
let liveQueries = 0;
const clientFiles: string[] = [];
for (const file of webFiles) {
  const text = await read(file);
  if (!/@gadgetinc\/|@gadget-client\/|from\s+["'][./]*api["']/.test(text)) continue;
  clientFiles.push(file);
  const usage = text.replace(/import\s[^;]*?from\s*["'][^"']+["'];?/g, "");
  for (const hook of HOOKS) {
    const count = (usage.match(new RegExp(`\\b${hook}\\b`, "g")) ?? []).length;
    if (count) hookCounts.set(hook, (hookCounts.get(hook) ?? 0) + count);
  }
  liveQueries += (text.match(/live\s*:\s*true/g) ?? []).length;
}
say(`## Frontend (references/frontend.md)`);
say();
list([
  `${clientFiles.length} files import the Gadget client or \`@gadgetinc/*\` packages`,
  ...[...hookCounts].sort((a, b) => b[1] - a[1]).map(([hook, count]) => `\`${hook}\`: ${count} uses`),
  ...(liveQueries ? [`\`live: true\`: ${liveQueries} live queries`] : []),
]);
say();

const extensionCallers: string[] = [];
for (const file of files.filter((file) => file.startsWith("extensions/") && /\.(ts|tsx|js|jsx|liquid|toml)$/.test(file))) {
  if (/\.gadget\.app\b|@gadgetinc\/shopify-extensions/.test(await read(file))) extensionCallers.push(file);
}
say(`## Shopify extensions that call the Gadget app (references/cutover.md)`);
say();
say(`Release new versions that point at the new app before moving tokens (references/shopify-tokens.md).`);
say();
list(extensionCallers.map((file) => `\`${file}\``));
say();

// ---------------------------------------------------------------- environment variables
const envNames = new Set<string>();
for (const file of files.filter((file) => /^(api|web|frontend)\//.test(file) && isCode(file))) {
  const text = await read(file);
  for (const match of text.matchAll(/process\.env\.([A-Z0-9_]+)|process\.env\[["']([A-Z0-9_]+)["']\]|import\.meta\.env\.([A-Z0-9_]+)/g)) {
    envNames.add(match[1] ?? match[2] ?? match[3]);
  }
}
const gadgetSet = [...envNames].filter((name) => name.startsWith("GADGET_"));
say(`## Environment variables (${envNames.size})`);
say();
list([
  ...[...envNames].filter((name) => !name.startsWith("GADGET_")).sort().map((name) => `\`${name}\`: copy the value to the new host`),
  ...gadgetSet.sort().map((name) => `\`${name}\`: set by Gadget, replace the code that reads it`),
]);
say();

console.log(out.join("\n"));
