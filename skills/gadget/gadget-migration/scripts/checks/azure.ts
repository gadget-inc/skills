// Checks for apps moving to Azure. references/platforms/azure.md explains each one.
import { DOCS, type CheckModule, type Finding, type Repo } from "./types.ts";
import { lineAt } from "./read-config.ts";
import { startOverrideFindings } from "./common.ts";
import { calls, closing, mask, props, skipString, skipTemplate, type Prop } from "./source-scan.ts";
import { arithmetic } from "./railway.ts";
import { prismaUrls } from "./render.ts";

const GUIDE = `${DOCS}/azure`;
const REF = "references/platforms/azure.md";

// ---------------------------------------------------------------------------------------------
// az commands in shell scripts, CI workflows, and Makefiles

interface Az {
  file: string;
  line: number;
  // the words after "az" up to the first flag, such as ["containerapp", "job", "create"]
  positional: string[];
  // every value after each flag, up to the next flag: --args run worker gives ["run", "worker"]
  flags: Map<string, string[][]>;
}

// The index of the ")" that closes the "$(" at i.
function substitutionEnd(text: string, i: number): number {
  let depth = 0;
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "(") depth++;
    else if (text[j] === ")" && --depth === 0) return j;
  }
  return text.length;
}

// Splits shell text into commands of words, joining backslash continuations and honoring quotes.
function shellCommands(text: string): { words: string[]; index: number }[] {
  const out: { words: string[]; index: number }[] = [];
  let words: string[] = [];
  let word: string | null = null;
  let start = -1;
  let wordStart = -1;
  const endWord = () => {
    if (word !== null) {
      if (!words.length) start = wordStart;
      words.push(word);
    }
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length) out.push({ words, index: start });
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && text[i + 1] === "\n") {
      i++;
      endWord();
      continue;
    }
    if (word === null && c === "#") {
      while (i < text.length && text[i] !== "\n") i++;
      endCommand();
      continue;
    }
    if (c === "\n" || c === ";" || (c === "&" && text[i + 1] === "&") || c === "|") {
      endCommand();
      if (text[i + 1] === c) i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      endWord();
      continue;
    }
    if (word === null) {
      word = "";
      wordStart = i;
    }
    if (c === "'") {
      const close = text.indexOf(c, i + 1);
      const end = close < 0 ? text.length : close;
      word += text.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      // "$(az ... --name "$RG")" keeps its inner quotes inside the substitution
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\") j += 2;
        else if (text[j] === "$" && text[j + 1] === "(") j = substitutionEnd(text, j) + 1;
        else j++;
      }
      word += text.slice(i + 1, j);
      i = j;
    } else if (c === "$" && text[i + 1] === "(") {
      const j = substitutionEnd(text, i);
      word += text.slice(i, j + 1);
      i = j;
    } else {
      word += c;
    }
  }
  endCommand();
  return out;
}

// NAME=value assignments in a script, with the variables they use filled in where the script assigns
// them. A value from a command substitution stays as its text, such as "$(az identity show ... --name
// my-app ...)", so two commands that use the same variable still compare equal.
function shellVariables(text: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const match of text.matchAll(/^\s*(?:export\s+)?([A-Za-z_]\w*)=("((?:[^"\\]|\\.|\$\([^)]*\))*)"|'([^']*)'|([^\s(]\S*|))\s*(?:#.*)?$/gm)) {
    const value = match[3] ?? match[4] ?? match[5] ?? "";
    // "${1:?usage}": an argument the script only knows when it runs, so "$ENV" stays as it is
    if (!/^\$\{?\d/.test(value)) vars.set(match[1], value);
  }
  for (let pass = 0; pass < 3; pass++) for (const [name, value] of vars) vars.set(name, substitute(value, vars));
  return vars;
}

// NAME=( ... ) arrays, so "${NAME[@]}" in a command becomes their words.
function shellArrays(text: string, vars: Map<string, string>): Map<string, string[]> {
  const arrays = new Map<string, string[]>();
  for (const match of text.matchAll(/^\s*([A-Za-z_]\w*)=\(([^)]*(?:\$\([^)]*\)[^)]*)*)\)\s*$/gm)) {
    arrays.set(match[1], shellCommands(match[2]).flatMap((c) => c.words).map((w) => substitute(w, vars)));
  }
  return arrays;
}

const substitute = (word: string, vars: Map<string, string>) => word.replace(/\$\{(\w+)\}|\$(\w+)/g, (whole, braced, bare) => vars.get(braced ?? bare) ?? whole);

const SHORT: Record<string, string> = { n: "name", g: "resource-group" };

function toAz(file: string, line: number, words: string[]): Az {
  const positional: string[] = [];
  const flags = new Map<string, string[][]>();
  let current: string[] | null = null;
  for (const w of words) {
    if (/^--?[a-zA-Z]/.test(w)) {
      const eq = w.indexOf("=");
      const raw = (eq < 0 ? w : w.slice(0, eq)).replace(/^--?/, "");
      const name = SHORT[raw] ?? raw;
      current = eq < 0 ? [] : [w.slice(eq + 1)];
      flags.set(name, [...(flags.get(name) ?? []), current]);
    } else if (current) current.push(w);
    else positional.push(w);
  }
  return { file, line, positional, flags };
}

function azCommands(repo: Repo): Az[] {
  const out: Az[] = [];
  const files = repo.files.filter((f) => /\.(sh|bash|ya?ml)$|(^|\/)Makefile$/.test(f) && !/(^|\/)(node_modules|test|tests|fixtures)\//.test(f));
  for (const file of files) {
    const text = repo.read(file) ?? "";
    if (!/\baz\s/.test(text)) continue;
    const shell = /\.(sh|bash)$/.test(file);
    const vars = shell ? shellVariables(text) : new Map<string, string>();
    const arrays = shell ? shellArrays(text, vars) : new Map<string, string[]>();
    const expand = (words: string[]) => words.flatMap((w) => arrays.get(/^\$\{(\w+)\[@\]\}$/.exec(w)?.[1] ?? "") ?? [substitute(w, vars)]);
    // commands inside $( ), such as EXECUTION=$(az containerapp job start ...), are commands of their own
    const chunks: { text: string; offset: number }[] = [{ text, offset: 0 }];
    for (let i = text.indexOf("$("); i >= 0; i = text.indexOf("$(", i + 2)) chunks.push({ text: text.slice(i + 2, substitutionEnd(text, i)), offset: i + 2 });
    for (const chunk of chunks) {
      for (const { words, index } of shellCommands(chunk.text)) {
        const at = words.indexOf("az");
        if (at >= 0 && words.length > at + 2) out.push(toAz(file, lineAt(text, chunk.offset + index), expand(words.slice(at + 1))));
      }
    }
  }
  return out;
}

const isCmd = (c: Az, ...prefix: string[]) => prefix.every((p, i) => c.positional[i] === p);
// the last value given for a flag, joined, or undefined when the flag isn't there
const flag = (c: Az, ...names: string[]) => names.map((n) => c.flags.get(n)?.at(-1)?.join(" ")).find((v) => v !== undefined);
// every value given for a flag, across repeats
const values = (c: Az, ...names: string[]) => names.flatMap((n) => (c.flags.get(n) ?? []).flat());
const has = (c: Az, ...names: string[]) => names.some((n) => c.flags.has(n));
const isApp = (c: Az) => isCmd(c, "containerapp") && ["create", "update", "up"].includes(c.positional[1]);
const isJob = (c: Az) => isCmd(c, "containerapp", "job") && ["create", "update"].includes(c.positional[2]);
const commandOf = (c: Az) => [flag(c, "command") ?? "", ...values(c, "args")].join(" ").trim();
const MIGRATION_COMMAND = /migrat|\bdb\s+push\b/;
const isMigrationJob = (c: Az) => isJob(c) && MIGRATION_COMMAND.test(commandOf(c));

// ---------------------------------------------------------------------------------------------
// Source helpers

// The [start, end) spans of a call's top-level arguments.
function callArgs(text: string, open: number, close: number): [number, number][] {
  const out: [number, number][] = [];
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") {
      const end = closing(text, i);
      if (end < 0) return out;
      i = end;
    } else if (c === '"' || c === "'") i = skipString(text, i);
    else if (c === "`") i = skipTemplate(text, i);
    else if (c === ",") {
      out.push([start, i]);
      start = i + 1;
    }
  }
  if (text.slice(start, close).trim()) out.push([start, close]);
  return out;
}

// The expression that starts at i, up to the next top-level comma, closing bracket, semicolon, or line end.
function valueAt(text: string, i: number): string {
  let j = i;
  while (j < text.length && !/[,;)}\]\n]/.test(text[j])) {
    const c = text[j];
    if (c === "(" || c === "[" || c === "{") {
      const end = closing(text, j);
      if (end < 0) break;
      j = end + 1;
    } else if (c === '"' || c === "'") j = skipString(text, j) + 1;
    else if (c === "`") j = skipTemplate(text, j) + 1;
    else j++;
  }
  return text.slice(i, j);
}

// The properties of an argument that is an object literal, or null when it's something else.
function objectArg(text: string, span: [number, number] | undefined): Prop[] | null {
  if (!span) return null;
  let i = span[0];
  while (i < span[1] && /\s/.test(text[i])) i++;
  return text[i] === "{" ? props(text, i) : null;
}

const prop = (list: Prop[], key: string) => list.find((p) => p.key === key);
const importsServiceBus = (text: string) => /from\s+["']@azure\/service-bus["']|require\(\s*["']@azure\/service-bus["']\s*\)/.test(text);

// ---------------------------------------------------------------------------------------------
// Service Bus receivers

function receiverFindings(repo: Repo, findings: Finding[]) {
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file) ?? "";
    if (!importsServiceBus(text)) continue;
    for (const call of calls(text, "\\.(?:createReceiver|acceptNextSession|acceptSession)")) {
      const method = text.slice(call.index + 1, call.open).trim();
      const args = callArgs(text, call.open, call.close);
      // createReceiver(queue, options) or (topic, subscription, options); acceptSession(queue, sessionId, options)
      const last = args.at(-1);
      const options = args.length >= 2 ? objectArg(text, last) : null;
      if (args.length >= 2 && !options && !/^\s*["'`]/.test(text.slice(last![0], last![1]))) continue; // options from a variable
      if (options?.some((p) => p.key === "...")) continue;
      const mode = options && prop(options, "receiveMode");
      if (mode && /["']receiveAndDelete["']/.test(mode.value)) {
        findings.push({
          id: "azure/receive-and-delete",
          severity: "error",
          file,
          line: lineAt(text, mode.index),
          message: "This receiver uses receiveAndDelete, so Service Bus deletes each message as it hands it over. A job that throws, or a replica that stops in the middle of one, loses the message with no retry, where Gadget retried a failed background action.",
          fix: "Leave receiveMode at its default, peekLock, and complete each message after its work succeeds, as the worker in the guide's section does.",
          docs: `${GUIDE}#process-messages-in-a-worker`,
        });
        continue;
      }
      const renewal = options && prop(options, "maxAutoLockRenewalDurationInMs");
      const ms = renewal ? arithmetic(renewal.value) : null;
      if (renewal && (ms === null || ms > 0)) continue;
      findings.push({
        id: "azure/lock-renewal",
        severity: "warning",
        file,
        line: lineAt(text, renewal ? renewal.index : call.index),
        message: renewal
          ? `This ${method} turns lock renewal off, so each message's lock lasts only the queue's lock duration. A message still running after that is delivered again to another receiver while the first copy runs.`
          : `This ${method} renews each message's lock for 5 minutes, the SDK's default, and a queue's lock lasts 5 minutes at most. With a 1-minute lock, a message that runs longer, such as an action that runs for 12 minutes, is delivered to a second replica at about minute 6 while the first copy still runs, and the first copy fails when it completes the message.`,
        error: "MessageLockLost",
        fix: "Set maxAutoLockRenewalDurationInMs to more than the longest job, such as 15 * 60 * 1000 in a worker. Scale-in and deploys still give a running message 30 seconds, so run longer work as a Container Apps job whose receiver renews for its whole --replica-timeout.",
        docs: `${GUIDE}#check-your-host-s-time-limits`,
      });
    }
  }
}

// A failed message comes back at once: an abandon, or a throw from processMessage with
// autoCompleteMessages on, puts it at the front of the queue with no delay.
function retryFindings(repo: Repo, findings: Finding[]) {
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file) ?? "";
    if (!importsServiceBus(text)) continue;
    const code = mask(text);
    if (/\bscheduleMessages\s*\(|\bscheduledEnqueueTimeUtc\b/.test(code)) continue;
    let at: number | null = null;
    let how = "";
    for (const call of calls(text, "\\.subscribe")) {
      const args = callArgs(text, call.open, call.close);
      const handlers = objectArg(text, args[0]);
      if (!handlers || !prop(handlers, "processMessage")) continue;
      const options = objectArg(text, args[1]);
      if (args[1] && !options) continue;
      if (options?.some((p) => p.key === "...")) continue;
      const auto = options && prop(options, "autoCompleteMessages");
      if (auto && /^false$/.test(auto.value.trim())) continue;
      at = call.index;
      how = "With autoCompleteMessages on, the SDK's default, a throw from processMessage abandons the message";
      break;
    }
    if (at === null) {
      const abandon = /\.abandonMessage\s*\(/.exec(code);
      if (abandon) {
        at = abandon.index;
        how = "abandonMessage hands the message back";
      }
    }
    if (at === null) continue;
    findings.push({
      id: "azure/immediate-retry",
      severity: "warning",
      file,
      line: lineAt(text, at),
      message: `${how}, and Service Bus delivers it again at once, with no delay between attempts. During a 30-second outage of an API the job calls, a queue with --max-delivery-count 10 uses all 10 deliveries within the first second and dead-letters the message. Gadget waited between retries and doubled the wait each time.`,
      fix: "Complete the failed message and schedule a copy with sender.scheduleMessages, with a delay that doubles each attempt, an attempt count in applicationProperties, and a new messageId built from the first message's id and the attempt number, because Service Bus refuses an id over 128 characters. The worker in the guide's section does this. Set autoCompleteMessages: false when the handler settles messages itself.",
      docs: `${GUIDE}#process-messages-in-a-worker`,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Config files

function keyVaultFindings(repo: Repo, findings: Finding[]) {
  const files = repo.files.filter((f) => /\.(sh|bash|ya?ml|bicep|json|tf)$/.test(f) && !/(^|\/)(node_modules|test|tests|fixtures)\/|package(-lock)?\.json$/.test(f));
  for (const file of files) {
    const text = repo.read(file) ?? "";
    if (!text.includes("vault.azure.net")) continue;
    const unpinned: { name: string; index: number }[] = [];
    for (const m of text.matchAll(/(?:keyvaultref:|keyVaultUrl["']?\s*[:=]\s*["']?)(https:\/\/[\w.-]+\.vault\.azure\.net\/secrets\/([^\s,"'/)]+)(\/[^\s,"')]*)?)/g)) {
      if (!m[3] || m[3] === "/") unpinned.push({ name: m[2], index: m.index! });
    }
    if (!unpinned.length) continue;
    const names = [...new Set(unpinned.map((u) => u.name))];
    findings.push({
      id: "azure/keyvault-unversioned",
      severity: "warning",
      file,
      line: lineAt(text, unpinned[0].index),
      message: `The Key Vault reference${names.length > 1 ? "s" : ""} to ${names.join(", ")} name${names.length > 1 ? "" : "s"} no version, so ${names.length > 1 ? "they follow" : "it follows"} the latest one. Container Apps picks up a new version within 30 minutes and restarts every revision that uses the secret in an environment variable, and each replica gets SIGTERM as in a deploy, with jobs in progress.`,
      fix: "Add the version to each reference, such as https://my-app-vault.vault.azure.net/secrets/shopify-api-secret/0f3c2a9d8e7b4c1a9f6e5d4c3b2a1f0e, and change it in the deploy that should pick up the new value.",
      docs: `${GUIDE}#environment-variables`,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Flexible Server

const parameter = (c: Az) => (isCmd(c, "postgres", "flexible-server", "parameter", "set") ? { name: flag(c, "name")?.toLowerCase(), value: flag(c, "value") ?? "" } : null);

function pgbouncerFindings(repo: Repo, commands: Az[], findings: Finding[]) {
  const deps = repo.dependencies();
  if (!deps["@prisma/client"] && !deps.prisma) return;
  const enabled = commands.find((c) => parameter(c)?.name === "pgbouncer.enabled" && /^(true|on)$/i.test(parameter(c)!.value));
  if (!enabled) return;
  const prepared = commands.some((c) => parameter(c)?.name === "pgbouncer.max_prepared_statements" && Number(parameter(c)!.value) > 0);
  if (prepared) return;
  if (repo.files.some((f) => !/(^|\/)node_modules\//.test(f) && /pgbouncer=true/.test(repo.read(f) ?? ""))) return;
  findings.push({
    id: "azure/pgbouncer-prepared",
    severity: "warning",
    file: enabled.file,
    line: enabled.line,
    message: "This turns on Flexible Server's PgBouncer, whose pgbouncer.max_prepared_statements is 0 by default, and nothing in the repository raises it or adds pgbouncer=true to a database URL. Prisma prepares named statements, so through port 6432 its queries fail at random: in a test of 300 queries through PgBouncer 1.26.1 at that setting, about half failed.",
    error: 'prepared statement "s0" does not exist',
    fix: "Set pgbouncer.max_prepared_statements to 200 with az postgres flexible-server parameter set, or end the app's port-6432 URL in Key Vault with ?pgbouncer=true. Keep the migration job's URL on port 5432.",
    docs: `${GUIDE}#connect-through-pgbouncer`,
  });
}

function openFirewallFindings(commands: Az[], findings: Finding[]) {
  for (const c of commands) {
    let what: string | null = null;
    let internet = false;
    if (isCmd(c, "postgres", "flexible-server", "create") || isCmd(c, "postgres", "flexible-server", "update")) {
      const access = flag(c, "public-access");
      if (access && /^(0\.0\.0\.0(-0\.0\.0\.0|-255\.255\.255\.255)?|all)$/i.test(access)) {
        what = `--public-access ${access}`;
        internet = /255|all/i.test(access);
      }
    }
    if (isCmd(c, "postgres", "flexible-server", "firewall-rule") && ["create", "update"].includes(c.positional[3])) {
      const start = flag(c, "start-ip-address");
      const end = flag(c, "end-ip-address");
      if (start === "0.0.0.0" && (end === undefined || end === "0.0.0.0" || end === "255.255.255.255")) {
        what = `A firewall rule from 0.0.0.0${end ? ` to ${end}` : ""}`;
        internet = end === "255.255.255.255";
      }
    }
    if (!what) continue;
    findings.push({
      id: "azure/db-open-to-azure",
      severity: "error",
      file: c.file,
      line: c.line,
      message: `${what} lets ${internet ? "every address on the internet" : "every Azure address, including other customers' subscriptions,"} reach the database's login prompt. Only its password stands between them and every store's records.`,
      fix: "Allow only the NAT gateway's address with a firewall rule, such as --start-ip-address 20.121.33.44, and your own address only while you load records.",
      docs: `${GUIDE}#map-your-models-to-database-tables`,
    });
  }
}

function extensionFindings(repo: Repo, commands: Az[], findings: Finding[]) {
  // the server is managed from these scripts; otherwise its parameters live somewhere the script can't see
  if (!commands.some((c) => isCmd(c, "postgres", "flexible-server", "create"))) return;
  const allowed = new Set(commands.flatMap((c) => (parameter(c)?.name === "azure.extensions" ? parameter(c)!.value.toLowerCase().split(/[\s,]+/) : [])).filter(Boolean));
  for (const file of repo.find(/\.sql$/)) {
    const sql = (repo.read(file) ?? "").replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
    for (const m of sql.matchAll(/create\s+extension\s+(?:if\s+not\s+exists\s+)?"?([\w-]+)"?/gi)) {
      const name = m[1].toLowerCase();
      if (name === "plpgsql" || allowed.has(name)) continue;
      findings.push({
        id: "azure/extensions-allowlist",
        severity: "error",
        file,
        line: lineAt(sql, m.index!),
        message: `This migration creates the ${name} extension, and no script adds ${name} to the server's azure.extensions parameter. Flexible Server refuses any extension that isn't on that list, which starts empty, so the migration job fails.`,
        error: `extension "${name}" is not allow-listed for "azure_pg_admin" users in Azure Database for PostgreSQL`,
        fix: `Run az postgres flexible-server parameter set --name azure.extensions --value ${[...allowed, name].join(",")} before the first migration, listing every extension your migrations create.`,
        docs: `${GUIDE}#map-your-models-to-database-tables`,
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Container Apps

function startFindings(repo: Repo, commands: Az[], findings: Finding[]) {
  for (const c of commands.filter((c) => (isApp(c) || isJob(c)) && has(c, "command") && !isMigrationJob(c))) {
    const out = startOverrideFindings(repo, "azure", c.file, c.line, commandOf(c), `${GUIDE}#rebuild-the-shopify-connection`);
    if (out.length) {
      findings.push(out[0]);
      return;
    }
  }
}

function scaleToZeroFindings(commands: Az[], findings: Finding[]) {
  for (const c of commands.filter((c) => isCmd(c, "containerapp", "create") && flag(c, "ingress") === "external")) {
    const min = flag(c, "min-replicas");
    if (min !== undefined && Number(min) >= 1) continue;
    findings.push({
      id: "azure/web-scale-to-zero",
      severity: "warning",
      file: c.file,
      line: c.line,
      message: `${flag(c, "name") ?? "This app"} takes external traffic with ${min === undefined ? "no --min-replicas, so Container Apps scales it to zero" : "--min-replicas 0"} when it gets no requests. The first webhook after a quiet night waits for a replica to pull the image and start the server, and Shopify counts a delivery that takes more than 5 seconds as failed.`,
      fix: "Add --min-replicas 2, so one replica answers while the other restarts.",
      docs: `${GUIDE}#receive-webhooks`,
    });
  }
}

// Which Key Vault secret each app or job reads an environment variable from, across every command
// that names it: --secrets on create, secret set, and --env-vars or --set-env-vars with secretref:.
interface Resource {
  kind: "app" | "job";
  name: string;
  first: Az;
  secrets: Map<string, string>;
  env: Map<string, string>;
  identities: Set<string>;
  migration: boolean;
}

function resources(commands: Az[]): Map<string, Resource> {
  const out = new Map<string, Resource>();
  for (const c of commands) {
    const job = isCmd(c, "containerapp", "job");
    const app = !job && isCmd(c, "containerapp");
    if (!job && !app) continue;
    const name = flag(c, "name");
    if (!name) continue;
    const key = `${job ? "job" : "app"}:${name}`;
    const r = out.get(key) ?? { kind: job ? "job" : "app", name, first: c, secrets: new Map(), env: new Map(), identities: new Set(), migration: false };
    out.set(key, r);
    if (job ? isJob(c) : isApp(c)) r.migration ||= isMigrationJob(c);
    for (const value of values(c, "secrets")) {
      const m = value.match(/^([\w.-]+)=keyvaultref:\S*?\/secrets\/([^/,\s]+)(?:\/[^,]*)?(?:,identityref:(.+))?$/);
      if (!m) continue;
      r.secrets.set(m[1], m[2]);
      if (m[3]) r.identities.add(m[3]);
    }
    for (const value of values(c, "env-vars", "set-env-vars", "replace-env-vars")) {
      const m = value.match(/^(\w+)=secretref:([\w.-]+)$/);
      if (m) r.env.set(m[1], m[2]);
    }
    for (const value of values(c, "user-assigned", "mi-user-assigned")) r.identities.add(value);
  }
  return out;
}

const vaultSecret = (r: Resource, variable: string) => {
  const local = r.env.get(variable);
  return local ? r.secrets.get(local) : undefined;
};

const sqlTable = (raw: string) => raw.replace(/"/g, "").split(".").pop()!.toLowerCase();

// Row-level security that never runs: an app reads its database URL from the Key Vault secret the
// migration job uses, so it connects as the admin user that owns the tables.
function ownerFindings(repo: Repo, commands: Az[], findings: Finding[]) {
  const protectedTables: { file: string; table: string }[] = [];
  const forced = new Set<string>();
  for (const file of repo.find(/\.sql$/)) {
    const sql = (repo.read(file) ?? "").replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
    for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w."]+)\s+force\s+row\s+level\s+security/gi)) forced.add(sqlTable(m[1]));
    for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w."]+)\s+enable\s+row\s+level\s+security|create\s+policy\s+(?:"[^"]+"|[\w$]+)\s+on\s+(?:only\s+)?([\w."]+)/gi)) {
      protectedTables.push({ file, table: sqlTable(m[1] ?? m[2]) });
    }
  }
  const unforced = protectedTables.filter((t) => !forced.has(t.table));
  if (!unforced.length) return;
  const { url, directUrl } = prismaUrls(repo);
  const appVar = url ?? "DATABASE_URL";
  const migrationVar = directUrl ?? appVar;
  const all = [...resources(commands).values()];
  for (const job of all.filter((r) => r.migration)) {
    const secret = vaultSecret(job, migrationVar);
    const user = secret && all.find((r) => r !== job && !r.migration && vaultSecret(r, appVar) === secret);
    if (!user) continue;
    const tables = [...new Set(unforced.map((t) => t.table))];
    findings.push({
      id: "azure/owner-skips-rls",
      severity: "error",
      file: job.first.file,
      line: job.first.line,
      message: `The migration job ${job.name} reads ${migrationVar} from the Key Vault secret ${secret}, and ${user.kind === "app" ? "the app" : "the job"} ${user.name} reads ${appVar} from the same secret, so it connects as the admin user that runs migrations and owns the tables. Postgres skips row-level security for a table's owner, and on PostgreSQL 16 and later the admin user very likely has BYPASSRLS too, so the policies on ${tables.join(", ")} (${unforced[0].file}) never apply to it.`,
      error: "a query with no store set returns every store's rows",
      fix: `Store the admin URL on port 5432 as a second secret, migrate-database-url, for ${job.name} only, and put the URL of an app_user role you create with SQL, on port 6432, in ${secret}. Then check as app_user that a query without app.shop_id set fails, with unrecognized configuration parameter "app.shop_id" on a fresh connection or invalid input syntax for type bigint: "" on a reused pooled one, or run scripts/db-check.sql as it.`,
      docs: `${GUIDE}#rewrite-permissions-and-shop-tenancy`,
    });
  }
}

function sharedIdentityFindings(commands: Az[], findings: Finding[]) {
  const all = [...resources(commands).values()];
  for (const job of all.filter((r) => r.migration)) {
    const user = all.find((r) => r !== job && !r.migration && [...r.identities].some((id) => job.identities.has(id)));
    if (!user) continue;
    const id = [...job.identities].find((value) => user.identities.has(value))!;
    // "$(az identity show ... --name my-app ...)" reads better as its name
    const shared = /az identity show[^)]*--name\s+"?([\w.-]+)/.exec(id)?.[1] ?? id;
    findings.push({
      id: "azure/migrate-shared-identity",
      severity: "warning",
      file: job.first.file,
      line: job.first.line,
      message: `The migration job ${job.name} uses the managed identity ${shared}, which ${user.name} uses too. Any code that runs as that identity can read the migration job's secret, the admin URL that skips row-level security.`,
      fix: "Give the migration job its own user-assigned identity, with the Key Vault Secrets User role on that one secret, and give no other identity access to it.",
      docs: `${GUIDE}#rewrite-permissions-and-shop-tenancy`,
    });
  }
}

function migrateDeployFindings(repo: Repo, commands: Az[], findings: Finding[]) {
  const jobs = new Set([...resources(commands).values()].filter((r) => r.migration).map((r) => r.name));
  for (const c of commands) if (isCmd(c, "containerapp", "job") && /migrat/.test(flag(c, "name") ?? "")) jobs.add(flag(c, "name")!);
  if (!jobs.size) return;
  const byFile = new Map<string, Az[]>();
  for (const c of commands) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);
  for (const [file, list] of byFile) {
    if (!/\.(sh|bash)$/.test(file)) continue;
    const updates = list.filter((c) => isCmd(c, "containerapp", "update") && has(c, "image"));
    if (!updates.length) continue;
    const text = repo.read(file) ?? "";
    const base = { id: "azure/migrate-before-deploy", file, docs: `${GUIDE}#run-migrations-once-per-deploy` } as const;
    const start = list.find((c) => isCmd(c, "containerapp", "job", "start") && jobs.has(flag(c, "name") ?? ""));
    if (!start) {
      const imageUpdate = list.find((c) => isCmd(c, "containerapp", "job", "update") && jobs.has(flag(c, "name") ?? "") && has(c, "image"));
      if (imageUpdate) {
        findings.push({ ...base, severity: "error", line: imageUpdate.line, message: `This gives the migration job ${flag(imageUpdate, "name")} the new image but never starts it, so the apps update without their migrations.`, fix: "Start it with az containerapp job start, wait for the execution to succeed, then update the apps." });
      }
      continue;
    }
    const firstUpdate = updates.find((c) => c.line > start.line);
    if (!firstUpdate) continue;
    const waits = list.some((c) => isCmd(c, "containerapp", "job", "execution") && c.line > start.line && c.line < firstUpdate.line);
    if (!waits) {
      findings.push({ ...base, severity: "error", line: start.line, message: `az containerapp job start returns once the execution of ${flag(start, "name")} exists, not when it finishes, so the next lines update the apps while migrations still run, and a failed migration doesn't stop them.`, fix: `Read the execution's name from job start, then poll az containerapp job execution show until properties.status is Succeeded, and exit on Failed, Stopped, or Degraded, as scripts/deploy.sh in ${REF} does.` });
    } else if (!/^\s*set\s+-[a-z]*e|^\s*set\s+-o\s+errexit/m.test(text)) {
      findings.push({ ...base, severity: "warning", line: start.line, message: "The script has no set -e, so a command that fails before the apps update, such as the image build, doesn't stop the deploy.", fix: "Add set -euo pipefail at the top of the script." });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Service Bus queues

// An ISO 8601 duration such as P1D or PT4H, in seconds
function isoSeconds(value: string): number | null {
  const m = value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!m || value.toUpperCase() === "P" || value.toUpperCase() === "PT") return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

function queueFindings(repo: Repo, commands: Az[], findings: Finding[]) {
  const usesIds = repo.sourceFiles().some((f) => {
    const text = repo.read(f) ?? "";
    return importsServiceBus(text) && /\bmessageId\s*:/.test(mask(text));
  });
  if (!usesIds) return;
  for (const c of commands.filter((c) => isCmd(c, "servicebus", "queue", "create"))) {
    const name = flag(c, "name") ?? "this queue";
    const detection = flag(c, "enable-duplicate-detection", "duplicate-detection");
    const base = { id: "azure/duplicate-detection", file: c.file, line: c.line, docs: `${GUIDE}#replace-background-and-scheduled-actions` } as const;
    if (detection === undefined || /^(0|f|false|n|no)$/i.test(detection)) {
      findings.push({ ...base, severity: "error", message: `The app sets messageId to drop repeated jobs, and ${name} is created without duplicate detection, so Service Bus keeps every message with a repeated id. Duplicate detection can only be turned on when the queue is created.`, fix: "Add --enable-duplicate-detection true and --duplicate-detection-history-time-window P1D, then delete and create the queue again before it holds messages." });
      continue;
    }
    const window = flag(c, "duplicate-detection-history-time-window", "d");
    const seconds = window === undefined ? 600 : isoSeconds(window);
    if (seconds === null || seconds >= 4 * 3600) continue;
    findings.push({ ...base, severity: "warning", message: `${name} drops a repeated messageId for ${window === undefined ? "10 minutes, the default" : window}. Shopify retries a failed webhook 8 times over 4 hours, so a retry that arrives 20 minutes after a delivery the app already queued runs a second time.`, fix: "Use --duplicate-detection-history-time-window P1D. Changing the window later works, but turning detection on does not." });
  }
}

// A scheduled script's message id built from the clock's date: a run that starts late or retries
// after midnight gets the next day's id, runs its work twice, and the next day's real run is dropped.
function scheduledIdFindings(repo: Repo, findings: Finding[]) {
  for (const file of repo.sourceFiles().filter((f) => /(^|\/)(scripts|jobs|cron|schedules?)\/|enqueue|schedul|cron/i.test(f))) {
    const text = repo.read(file) ?? "";
    if (!importsServiceBus(text)) continue;
    const code = mask(text, false);
    if (/\.set(?:UTC)?Hours\s*\(/.test(code)) continue;
    const id = /\bmessageId\s*:\s*/.exec(code) ?? /(?<=[{,]\s*)messageId(?=\s*[,}])/.exec(code);
    if (!id) continue;
    const expression = id[0].includes(":") ? valueAt(code, id.index + id[0].length) : "messageId";
    const declared = (name: string) => {
      const m = new RegExp(`(?:const|let|var)\\s+${name.replace(/\$/g, "\\$")}\\b[^=]*=\\s*`).exec(code);
      return m ? valueAt(code, m.index + m[0].length) : "";
    };
    const parts = [expression, ...[...expression.matchAll(/\$\{\s*([\w$]+)|^\s*([\w$]+)\s*$/g)].map((m) => declared(m[1] ?? m[2]))];
    const fromClock = parts.some((p) => /new Date\(\s*\)/.test(p) && /\.slice\(\s*0\s*,\s*(10|13)\s*\)|toDateString|toLocaleDateString|get(?:UTC)?Date\(\s*\)/.test(p));
    if (!fromClock) continue;
    findings.push({
      id: "azure/scheduled-id-clock",
      severity: "error",
      file,
      line: lineAt(text, id.index),
      message: "This builds the message id from the clock's date. Container Apps passes no scheduled time to a job, so a run scheduled for 23:30 that retries at 00:10 gets the next day's id and runs its work a second time, and the next day's real run then carries an id the queue already holds and is dropped.",
      fix: "Build the id from the most recent scheduled time at or before now, such as the latest 02:00 UTC for 0 2 * * *: set the hours with setUTCHours, and go back a day when that time is still ahead.",
      docs: `${GUIDE}#replace-scheduled-actions`,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Blob Storage and email

function blobFindings(repo: Repo, commands: Az[], findings: Finding[]) {
  if (!("@azure/storage-blob" in repo.dependencies())) return;
  const sources = repo.sourceFiles();
  const sendsHeader = sources.some((f) => /x-ms-blob-type/i.test(repo.read(f) ?? ""));
  if (!sendsHeader) {
    for (const file of sources) {
      const text = repo.read(file) ?? "";
      const put = calls(text, "\\bfetch").find((call) => {
        const options = objectArg(text, callArgs(text, call.open, call.close)[1]);
        return !!options && /^["'`]PUT["'`]$/i.test(prop(options, "method")?.value ?? "") && /file|blob/i.test(prop(options, "body")?.value ?? "");
      });
      if (!put) continue;
      findings.push({
        id: "azure/blob-type-header",
        severity: "error",
        file,
        line: lineAt(text, put.index),
        message: "This uploads a file with a PUT and no x-ms-blob-type header. Blob Storage's Put Blob requires x-ms-blob-type: BlockBlob, so an upload written for S3 or Google Cloud Storage gets 400.",
        error: "400 from Blob Storage on the upload",
        fix: 'Add headers: { "x-ms-blob-type": "BlockBlob", "content-type": file.type } to the request, and allow x-ms-blob-type in the storage account\'s CORS rule.',
        docs: `${GUIDE}#search-files-and-other-services`,
      });
      break;
    }
  }
  for (const c of commands.filter((c) => isCmd(c, "storage", "cors", "add"))) {
    if (!/b/.test(flag(c, "services") ?? "") || !/\bPUT\b/i.test(values(c, "methods").join(" "))) continue;
    const headers = values(c, "allowed-headers").join(" ").toLowerCase();
    if (/x-ms-blob-type|\*|x-ms-\*/.test(headers)) continue;
    findings.push({
      id: "azure/blob-cors-header",
      severity: "error",
      file: c.file,
      line: c.line,
      message: `This CORS rule allows PUT ${headers ? `with only ${headers}` : "with no allowed headers"}, so the browser's preflight for an upload that sends x-ms-blob-type fails and the browser never sends the file.`,
      error: "403 CorsPreflightFailure",
      fix: "Add x-ms-blob-type to --allowed-headers, such as --allowed-headers content-type x-ms-blob-type.",
      docs: `${GUIDE}#search-files-and-other-services`,
    });
  }
}

function smtpFindings(repo: Repo, findings: Finding[]) {
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file) ?? "";
    if (!/createTransport|setTransport/.test(text)) continue;
    for (const call of calls(text, "\\b(?:createTransport|setTransport)")) {
      const options = objectArg(text, callArgs(text, call.open, call.close)[0]);
      const port = options && prop(options, "port");
      if (!port || !/^["']?25["']?$/.test(port.value.trim())) continue;
      findings.push({
        id: "azure/smtp-port-25",
        severity: "error",
        file,
        line: lineAt(text, port.index),
        message: "This sends mail on port 25, which Microsoft calls unsupported from Container Apps and every managed service other than App Service and Functions on a virtual network. The connection never opens.",
        fix: "Send on port 587 with STARTTLS, or through your email provider's HTTP API.",
        docs: `${GUIDE}#email-and-custom-domains`,
      });
      break;
    }
  }
}

// ---------------------------------------------------------------------------------------------

export const azure: CheckModule = {
  platform: "azure",
  title: "Azure",
  detect: (repo) => {
    const deps = repo.dependencies();
    if ("@azure/service-bus" in deps || "@azure/storage-blob" in deps) return true;
    if (repo.exists("azure.yaml") || repo.files.some((f) => /\.bicep$/.test(f) && !/(^|\/)node_modules\//.test(f))) return true;
    return azCommands(repo).some((c) => isCmd(c, "containerapp") || isCmd(c, "postgres", "flexible-server") || isCmd(c, "servicebus"));
  },
  // When every app passes --command, Container Apps never starts the Dockerfile's CMD
  suppresses: (repo) => {
    const apps = azCommands(repo).filter((c) => isCmd(c, "containerapp", "create"));
    return apps.length > 0 && apps.every((c) => has(c, "command")) ? ["common/migrate-on-start"] : [];
  },
  run: (repo) => {
    const findings: Finding[] = [];
    const commands = azCommands(repo);
    receiverFindings(repo, findings);
    retryFindings(repo, findings);
    keyVaultFindings(repo, findings);
    pgbouncerFindings(repo, commands, findings);
    openFirewallFindings(commands, findings);
    extensionFindings(repo, commands, findings);
    startFindings(repo, commands, findings);
    scaleToZeroFindings(commands, findings);
    ownerFindings(repo, commands, findings);
    sharedIdentityFindings(commands, findings);
    migrateDeployFindings(repo, commands, findings);
    queueFindings(repo, commands, findings);
    scheduledIdFindings(repo, findings);
    blobFindings(repo, commands, findings);
    smtpFindings(repo, findings);
    return findings;
  },
};
