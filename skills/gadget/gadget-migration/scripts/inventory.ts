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
    /google(OAuth)?\s*:/.test(settings) && "Google sign-in (see references/users-and-auth.md)",
    /bigcommerce\s*:/i.test(settings) && "BigCommerce connection (see references/bigcommerce.md)",
    /openai\s*:/i.test(settings) && "OpenAI connection (see references/other-connections.md)",
    /chatgpt\s*:/i.test(settings) && "ChatGPT connection: Gadget runs the OAuth server for it (see references/other-connections.md)",
    /sentry\s*:/i.test(settings) && "Sentry connection (see references/other-connections.md)",
    /customerAuthenticationEnabled\s*:\s*true/.test(settings) && "Shopify customer account sign-in is on: customers reach the app with Shopify session tokens (see references/shopify-signatures.md)",
    settings && !/shopify\s*:/.test(settings) && "No Shopify connection: start from references/non-shopify-apps.md",
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
  computed: "Gelly: rewrite as a SQL view or query (references/schema-mapping.md)",
  vector: "pgvector column: check dimensions and indexes (references/schema-mapping.md)",
  roleList: "the Internal API returns role names, the CSV export role keys (references/data-export.md)",
  richText: "exported as `{ markdown }`: store the markdown string (references/schema-mapping.md)",
  money: "deprecated type, exported as `{ amount, currency }` (references/schema-mapping.md)",
  recordState: "deprecated type, exported as a state name or a nested object (references/schema-mapping.md)",
};
// relationship and computed fields have no column of their own to export
const NOT_STORED = new Set(["hasMany", "hasOne", "hasManyThrough", "computed"]);
// field types whose unique validation ignores case unless it sets caseSensitive
const CASE_INSENSITIVE_UNIQUE = new Set(["string", "email", "url", "richText"]);
// records Gadget writes for its own bookkeeping: they use Gadget ids, and Shopify can't backfill them
const GADGET_MANAGED: Record<string, string> = {
  shopifySync: "Gadget's sync history: export only if you want the history",
  shopifyGdprRequest: "Gadget's log of compliance webhooks: export it if you keep these as records",
};
// reserved words in Postgres that are common model names: `create table user` is a syntax error
const RESERVED_TABLE_NAMES = new Set(["user", "order", "group", "table", "column", "check", "limit", "offset", "grant"]);
const tableName = (model: string) => {
  const name = model
    .replace(/\//g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  return RESERVED_TABLE_NAMES.has(name) ? `${name}s` : name;
};

const schemaFiles = files.filter((file) => /^api\/models\/.+\/schema\.gadget\.(ts|js)$/.test(file)).sort();
const modelNames: string[] = [];
const shopifyModels = new Set<string>();
const careLines: string[] = [];
const relationshipLines: string[] = [];

say(`## Models (${schemaFiles.length})`);
say();
say(
  `Each model becomes a table. See references/schema-mapping.md for column types and references/data-export.md for getting the records out. Every model also has \`id\`, \`createdAt\`, and \`updatedAt\` fields, which its schema file does not list.`
);
say();
say(`| Model | Suggested table | Kind | Fields your app defined | What to do |`);
say(`|---|---|---|---|---|`);
for (const file of schemaFiles) {
  // a namespaced model keeps its folders in the name, such as billing/invoice
  const model = file.replace(/^api\/models\//, "").replace(/\/schema\.gadget\.(ts|js)$/, "");
  modelNames.push(model);
  let schema: any;
  try {
    schema = await loadExport(file, "schema");
  } catch (error) {
    say(`| \`${model}\` | \`${tableName(model)}\` | ? | ? | could not load: ${(error as Error).message.split("\n")[0]} |`);
    continue;
  }
  const fields = Object.entries<any>(schema?.fields ?? {});
  const shopifyFields: string[] = schema?.shopify?.fields ?? [];
  const baseName = model.split("/").pop()!;
  // a model from the Shopify connection, not a custom model whose name happens to start with "shopify"
  const fromConnection = /^shopify[A-Z]/.test(baseName) && (Boolean(schema?.shopify) || /^DataModel-Shopify-/.test(schema?.storageKey ?? ""));
  const isSession = baseName === "session";
  const isGadgetManaged = fromConnection && baseName in GADGET_MANAGED;
  if (fromConnection) shopifyModels.add(model);
  const counts = new Map<string, number>();
  const toExport: string[] = [];
  const metafields: string[] = [];
  for (const [name, field] of fields) {
    counts.set(field.type, (counts.get(field.type) ?? 0) + 1);
    if (field.shopifyMetafield) metafields.push(name);
    else if (!NOT_STORED.has(field.type)) toExport.push(name);
    if (NEEDS_CARE[field.type]) careLines.push(`\`${model}.${name}\` (${field.type}): ${NEEDS_CARE[field.type]}`);
    if (field.type === "file") {
      const urls = field.allowPublicAccess ? "these URLs are public, so replace any you stored elsewhere" : "private URLs expire after 3 hours";
      careLines.push(`\`${model}.${name}\` (file): download each file from its URL; ${urls} (references/data-export.md)`);
    }
    if (field.type === "belongsTo") relationshipLines.push(`\`${model}.${name}\` belongs to \`${field.parent?.model}\``);
    if (field.type === "hasManyThrough") relationshipLines.push(`\`${model}.${name}\` has many \`${field.sibling?.model}\` through \`${field.join?.model}\``);
    if (field.type === "enum" && field.acceptMultipleSelections) careLines.push(`\`${model}.${name}\` (enum, multiple values): use \`text[]\``);
    if (field.type === "enum" && field.acceptUnlistedOptions) careLines.push(`\`${model}.${name}\` (enum) accepts values outside its options: skip the \`check\` constraint`);
    if (field.type === "dateTime" && field.includeTime === false) careLines.push(`\`${model}.${name}\` (dateTime without a time): use \`date\``);
    if (field.shopifyMetafield) {
      const { namespace, key } = field.shopifyMetafield;
      careLines.push(`\`${model}.${name}\` holds the Shopify metafield \`${namespace ?? "?"}.${key ?? "?"}\`: backfill it from Shopify instead of exporting it (references/shopify-sync.md)`);
    }
    const unique = field.validations?.unique;
    if (unique) {
      const ignoresCase = CASE_INSENSITIVE_UNIQUE.has(field.type) && unique.caseSensitive !== true;
      const scope = unique.scopeByField ? ` per \`${unique.scopeByField}\`` : "";
      const index = ignoresCase ? ", ignoring case: add a unique index on `lower(...)`" : ": add a unique index";
      careLines.push(`\`${model}.${name}\` is unique${scope}${index} (references/schema-mapping.md)`);
    }
  }
  const summary = [...counts].map(([type, count]) => `${count} ${type}`).join(", ");
  let kind = "custom";
  let notes = "export from production";
  if (isSession) {
    kind = "session";
    notes = "don't export: your new sign-in sessions or Shopify session tokens replace these";
  } else if (isGadgetManaged) {
    kind = "Gadget-managed";
    notes = GADGET_MANAGED[baseName];
  } else if (fromConnection) {
    kind = "Shopify";
    const backfill = `backfill the ${shopifyFields.length} Shopify fields${metafields.length ? ` and ${metafields.length} metafield field${metafields.length === 1 ? "" : "s"}` : ""} from Shopify`;
    notes = toExport.length ? `${backfill}; export only ${toExport.map((name) => `\`${name}\``).join(", ")}, with \`id\`` : `${backfill}; nothing to export`;
    if (baseName === "shopifyShop") notes += ". Its access tokens move separately (references/shopify-tokens.md)";
  }
  say(`| \`${model}\` | \`${tableName(model)}\` | ${kind} | ${summary || "none"} | ${notes} |`);
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

// computed views are saved Gelly queries, called as api.<name>() or through api.view("...")
const viewFiles = files.filter((file) => /^api\/(.+\/)?views\/.+\.gelly$/.test(file)).sort();
let inlineViews = 0;
for (const file of files.filter((file) => /^(api|web|frontend)\//.test(file) && isCode(file))) {
  inlineViews += ((await read(file)).match(/\bapi\.(\w+\.)*view\(/g) ?? []).length;
}
if (viewFiles.length || inlineViews) {
  say(`### Computed views (references/computed-views.md)`);
  say();
  list([
    ...viewFiles.map((file) => `\`${file}\`: rewrite as a SQL query or view`),
    ...(inlineViews ? [`${inlineViews} inline \`api.view(...)\` calls: rewrite each Gelly query as SQL`] : []),
  ]);
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
    const roles = Object.entries<any>((await loadExport(permissionsFile, "permissions")).roles ?? {});
    // the data editor's CSV export writes each role's key, which is its storageKey in this file
    const describe = ([name, role]: [string, any]) => (role?.storageKey && role.storageKey !== name ? `\`${name}\` (key \`${role.storageKey}\`)` : `\`${name}\``);
    roleLine = `Roles: ${roles.map(describe).join(", ") || "none found"}`;
  } catch (error) {
    roleLine = `Could not load \`${permissionsFile}\`: ${(error as Error).message.split("\n")[0]}`;
  }
  list([roleLine, ...filterFiles.map((file) => `Gelly filter: \`${file}\``)]);
} else {
  list([]);
}
say();

// ---------------------------------------------------------------- frontend
const HOOKS = ["useFindMany", "useFindOne", "useFindFirst", "useFindBy", "useMaybeFindOne", "useMaybeFindFirst", "useGet", "useAction", "useGlobalAction", "useBulkAction", "useActionForm", "useList", "useTable", "useUser", "useSession", "useAuth", "useSignOut", "SignedIn", "SignedOut", "SignedInOrRedirect", "SignedOutOrRedirect", "AutoTable", "AutoForm", "AutoButton", "useEnqueue", "useView", "useQuery", "useMutation", "useFetch", "gadgetConfig"];
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

// ---------------------------------------------------------------- other Gadget features in use
// Text scans across action, route, frontend, and extension code. Each hit names the reference that
// covers the replacement. A pattern can match unrelated code, so confirm each line.
const FEATURES: { label: string; pattern: RegExp; reference: string }[] = [
  { label: "Full text search (`search` or `searchFields`)", pattern: /\bsearch(Fields)?\s*:/, reference: "references/search.md" },
  { label: "File uploads (`directUploadToken`, `copyURL`, or `base64`)", pattern: /\bgetDirectUploadToken\b|\bdirectUploadToken\b|\bcopyURL\s*:|\bbase64\s*:/, reference: "references/files-and-storage.md" },
  { label: "Vector similarity (`cosineSimilarity` or `l2Distance`)", pattern: /\b(cosineSimilarity|l2Distance)(To)?\b/, reference: "references/other-connections.md" },
  { label: "OpenAI connection (`connections.openai` or `openAIResponseStream`)", pattern: /\bconnections\.openai\b|\bopenAIResponseStream\b/, reference: "references/other-connections.md" },
  { label: "MCP server (`@modelcontextprotocol/sdk`)", pattern: /@modelcontextprotocol\/sdk/, reference: "references/other-connections.md" },
  { label: "Sentry SDK (`@sentry/node`)", pattern: /@sentry\/node/, reference: "references/other-connections.md" },
  { label: "BigCommerce connection (`connections.bigcommerce` or `@gadgetinc/react-bigcommerce`)", pattern: /\bconnections\.bigcommerce\b|@gadgetinc\/react-bigcommerce/, reference: "references/bigcommerce.md" },
  { label: "Server-side loaders that use Gadget's context (`context.api`, `context.session`, `context.gadgetConfig`)", pattern: /\bcontext\.(api|session|gadgetConfig)\b/, reference: "references/non-shopify-apps.md" },
  { label: "Clients that authenticate with an API key (`authenticationMode: { apiKey }`)", pattern: /authenticationMode\s*:\s*\{\s*apiKey\b/, reference: "references/external-api-clients.md" },
  { label: "Pages that load the Gadget client from `/api/client/web.min.js`", pattern: /\/api\/client\/web(\.min)?\.js/, reference: "references/external-api-clients.md" },
];
const featureHits = new Map<string, string[]>();
for (const file of files.filter((file) => /^(api|web|frontend|extensions)\//.test(file) && isCode(file))) {
  const text = await read(file);
  for (const feature of FEATURES) {
    if (feature.pattern.test(text)) featureHits.set(feature.label, [...(featureHits.get(feature.label) ?? []), file]);
  }
}
const describeFiles = (hits: string[]) => `${hits.length} file${hits.length === 1 ? "" : "s"}: ${hits.slice(0, 5).map((file) => `\`${file}\``).join(", ")}${hits.length > 5 ? ", and more" : ""}`;

say(`## Other Gadget features in use`);
say();
list([
  ...FEATURES.filter((feature) => featureHits.has(feature.label)).map((feature) => `${feature.label} in ${describeFiles(featureHits.get(feature.label)!)} (see ${feature.reference})`),
  ...(hookCounts.has("AutoTable") ? ["`AutoTable` has a built-in search box, so those pages use search (see references/search.md)"] : []),
]);
say();

// ---------------------------------------------------------------- callers outside the repository
// Nothing in the pulled files shows who calls the app from outside. These are the places they leave a trace.
const FRONTEND_ROLES = new Set(["unauthenticated", "signed-in", "shopify-app-users", "shopify-storefront-customers", "bigcommerce-app-users", "system-admin"]);
let outsideRoles: string[] = [];
if (permissionsFile) {
  try {
    const roles = (await loadExport(permissionsFile, "permissions")).roles ?? {};
    outsideRoles = Object.keys(roles).filter((role) => !FRONTEND_ROLES.has(role));
  } catch {
    // already reported in the access control section
  }
}
say(`## Callers outside this repository (references/external-api-clients.md)`);
say();
say(`The pulled files can't show who calls the app from outside. Check each of these by hand:`);
say();
list([
  "API keys: list them in the production environment under Settings > API keys. Each key is at least one outside caller",
  outsideRoles.length ? `Custom roles, which are often made for an API key: ${outsideRoles.map((role) => `\`${role}\``).join(", ")}` : "No custom roles found, so outside callers use a built-in role or an admin API key",
  `${routeFiles.length} HTTP routes: each is a URL something calls. Third-party webhook URLs are saved in that service's dashboard`,
  "Other repositories, mobile apps, storefront themes, and automation tools that use `@gadget-client/*`, the app's `/api/graphql` endpoint, or the `/api/client/web.min.js` script",
  "A `gadget.app` domain can't be repointed, so every outside caller needs the new URL. A custom domain can, which keeps route URLs working",
]);
say();

console.log(out.join("\n"));
