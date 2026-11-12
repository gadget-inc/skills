// Checks for apps moving to AWS. references/platforms/aws.md explains each one.
import { DOCS, type CheckModule, type Finding, type Repo } from "./types.ts";
import { keyLine, lineAt, lineOf, parseJsoncWithLines } from "./read-config.ts";
import { expandScripts, startOverrideFindings } from "./common.ts";
import { arithmetic } from "./railway.ts";
import { prismaUrls } from "./render.ts";
import { calls, mask, props } from "./source-scan.ts";

const GUIDE = `${DOCS}/aws`;
const REF = "references/platforms/aws.md";

// ---------------------------------------------------------------------------------------------
// aws commands in shell scripts, CI workflows, and Makefiles

interface Aws {
  file: string;
  line: number;
  flags: Map<string, string[]>;
  // the service, the operation, and any other words, such as ["ecs", "wait", "tasks-stopped"]
  positional: string[];
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
      // inside double quotes, a backslash escapes ", \, $, and `, and joins a continued line
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === "\\" && j + 1 < text.length) {
          const next = text[j + 1];
          if (next === "\n") {
            j++;
            continue;
          }
          if ('"\\$`'.includes(next)) {
            word += next;
            j++;
            continue;
          }
        }
        word += text[j];
      }
      i = j;
    } else if (c === "$" && text[i + 1] === "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")" && --depth === 0) break;
      }
      // a command substitution holds its own commands, such as TASK=$(aws ecs run-task ...)
      for (const inner of shellCommands(text.slice(i + 2, j))) out.push({ words: inner.words, index: i + 2 + inner.index });
      word += text.slice(i, j + 1);
      i = j;
    } else {
      word += c;
    }
  }
  endCommand();
  return out;
}

// Plain NAME=value assignments in a script, so "$NETWORK" in a command can be read.
function shellVariables(text: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const match of text.matchAll(/^\s*(?:export\s+)?([A-Za-z_]\w*)=("([^"]*)"|'([^']*)'|(\S*))\s*(?:#.*)?$/gm)) {
    vars.set(match[1], match[3] ?? match[4] ?? match[5] ?? "");
  }
  for (let pass = 0; pass < 3; pass++) for (const [name, value] of vars) vars.set(name, substitute(value, vars));
  for (const [name, value] of vars) if (value.includes("$")) vars.delete(name);
  return vars;
}

function substitute(word: string, vars: Map<string, string>): string {
  return word.replace(/\$\{(\w+)\}|\$(\w+)/g, (whole, braced, bare) => vars.get(braced ?? bare) ?? whole);
}

// Options that take no value, so the word after one is the next option or a positional word
const BOOLEAN_FLAGS = new Set(["storage-encrypted", "multi-az", "publicly-accessible", "deletion-protection", "force-new-deployment", "enable-execute-command", "copy-tags-to-snapshot", "auto-minor-version-upgrade", "enable-iam-database-authentication", "manage-master-user-password", "require-tls", "debug", "dry-run", "no-verify-ssl", "no-paginate", "no-sign-request"]);
const GLOBAL_FLAGS = new Set(["region", "profile", "output", "endpoint-url", "color", "cli-connect-timeout", "cli-read-timeout", "ca-bundle", "cli-binary-format", "no-cli-pager", "no-verify-ssl"]);

function toAws(file: string, line: number, words: string[]): Aws {
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w.startsWith("--")) {
      positional.push(w);
      continue;
    }
    const eq = w.indexOf("=");
    const name = (eq < 0 ? w : w.slice(0, eq)).slice(2);
    let value = eq < 0 ? "" : w.slice(eq + 1);
    const takesValue = !BOOLEAN_FLAGS.has(name) && !name.startsWith("no-");
    if (eq < 0 && takesValue && i + 1 < words.length && !words[i + 1].startsWith("--")) value = words[++i];
    if (!GLOBAL_FLAGS.has(name)) flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { file, line, flags, positional };
}

const SCRIPT = /\.(sh|bash|ya?ml)$|(^|\/)Makefile$/;

function awsCommands(repo: Repo): Aws[] {
  const out: Aws[] = [];
  for (const file of repo.files.filter((f) => SCRIPT.test(f))) {
    const text = repo.read(file) ?? "";
    if (!/\baws\s+[a-z]/.test(text)) continue;
    const vars = /\.(sh|bash)$/.test(file) ? shellVariables(text) : new Map<string, string>();
    for (const { words, index } of shellCommands(text)) {
      const at = words.indexOf("aws");
      if (at >= 0 && words.length > at + 2 && /^[a-z0-9-]+$/.test(words[at + 1])) out.push(toAws(file, lineAt(text, index), words.slice(at + 1).map((w) => substitute(w, vars))));
    }
  }
  return out.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

const flag = (c: Aws, name: string) => c.flags.get(name)?.at(-1);
const has = (c: Aws, ...names: string[]) => names.some((n) => c.flags.has(n));
const isCmd = (c: Aws, ...prefix: string[]) => prefix.every((p, i) => c.positional[i] === p);

// ---------------------------------------------------------------------------------------------
// ECS task definitions: JSON files with containerDefinitions, as register-task-definition takes them

interface Container {
  def: TaskDef;
  node: any;
  name: string;
  // the command as one string, or "" when the container runs the image's CMD
  command: string;
  // names set by environment and secrets
  names: Set<string>;
}

interface TaskDef {
  file: string;
  doc: any;
  family: string;
  containers: Container[];
}

function taskDefinitions(repo: Repo, findings: Finding[]): TaskDef[] {
  const out: TaskDef[] = [];
  for (const file of repo.files.filter((f) => /\.json$/.test(f) && !/(^|\/)(package|package-lock|tsconfig|composer)\.json$/.test(f))) {
    const text = repo.read(file) ?? "";
    if (!text.includes('"containerDefinitions"')) continue;
    let doc: any;
    try {
      doc = parseJsoncWithLines(text);
    } catch (error) {
      findings.push({
        id: "aws/unreadable-config",
        severity: "manual",
        file,
        message: `The checks couldn't read ${file} (${(error as Error).message}), so they couldn't check its containers.`,
        fix: `Check its stopTimeout, variables, and secrets by hand, as ${REF} describes.`,
      });
      continue;
    }
    // a file from describe-task-definition wraps the definition in taskDefinition
    if (doc && !Array.isArray(doc.containerDefinitions) && doc.taskDefinition) doc = doc.taskDefinition;
    if (!Array.isArray(doc?.containerDefinitions)) continue;
    const def: TaskDef = { file, doc, family: String(doc.family ?? file.replace(/^.*\/|\.json$/g, "")), containers: [] };
    for (const node of doc.containerDefinitions) {
      if (!node || typeof node !== "object") continue;
      const command = Array.isArray(node.command) ? node.command.map(String).join(" ") : typeof node.command === "string" ? node.command : "";
      const names = new Set<string>([...(Array.isArray(node.environment) ? node.environment : []), ...(Array.isArray(node.secrets) ? node.secrets : [])].map((e: any) => String(e?.name ?? "")));
      def.containers.push({ def, node, name: String(node.name ?? ""), command, names });
    }
    out.push(def);
  }
  return out;
}

// a Node command, or one that a shell runs, such as sh -c "npx prisma migrate deploy && npm run worker"
const NODE_COMMAND = /^(npm|npx|node|pnpm|yarn|bun|tsx)\b|^(sh|bash)\s+-c\s+.*\b(npm|npx|node|pnpm|yarn|bun)\b/;
const ONLY_MIGRATES = /^(npx\s+|pnpm\s+(exec\s+)?|yarn\s+)?prisma\s+(migrate|db)\b|^npm\s+run\s+[\w:-]*migrat/;

// The containers that run the app's own code: a Node command, or the image's CMD when it's the only container
function appContainers(def: TaskDef): Container[] {
  return def.containers.filter((c) => NODE_COMMAND.test(c.command) || (!c.command && def.containers.length === 1));
}

const isMigration = (repo: Repo, c: Container) => ONLY_MIGRATES.test(c.command) || (/migrat/i.test(c.def.family) && !/start|worker|serve/.test(expandScripts(repo, c.command)));
const lineOfContainer = (c: Container, key?: string) => (key ? keyLine(c.node, key) : undefined) ?? keyLine(c.def.doc.containerDefinitions, c.def.doc.containerDefinitions.indexOf(c.node)) ?? keyLine(c.def.doc, "containerDefinitions");

function stopTimeoutFindings(repo: Repo, defs: TaskDef[], findings: Finding[]) {
  for (const def of defs) {
    const fargate = Array.isArray(def.doc.requiresCompatibilities) && def.doc.requiresCompatibilities.includes("FARGATE");
    for (const c of appContainers(def).filter((c) => !isMigration(repo, c))) {
      const value = c.node.stopTimeout;
      if (typeof value === "number" && value > 120 && fargate) {
        findings.push({
          id: "aws/stop-timeout",
          severity: "warning",
          file: def.file,
          line: lineOfContainer(c, "stopTimeout"),
          message: `${def.family} sets stopTimeout to ${value}, and Fargate allows at most 120 seconds between SIGTERM and SIGKILL, so a deploy still stops a job that runs longer than 2 minutes.`,
          fix: "Set stopTimeout to 120, and run jobs longer than 2 minutes as tasks of their own with RunTask, or under task scale-in protection.",
          docs: `${GUIDE}#check-your-host-s-time-limits`,
        });
        continue;
      }
      const worker = /worker|jobs?\b|queue/i.test(`${def.family} ${c.name} ${c.command}`);
      if (!worker || (typeof value === "number" && value >= 120)) continue;
      findings.push({
        id: "aws/stop-timeout",
        severity: "warning",
        file: def.file,
        line: lineOfContainer(c, "stopTimeout"),
        message: `${def.family} runs jobs and ${typeof value === "number" ? `sets stopTimeout to ${value}` : "has no stopTimeout, so ECS uses 30 seconds"}. Every deploy and scale-in sends SIGTERM and then SIGKILL that many seconds later, and the job it kills runs again from the start once its visibility timeout ends.`,
        error: "the job's message comes back after its visibility timeout, and the job runs again",
        fix: "Set stopTimeout to 120 on the worker's container, stop taking new jobs on SIGTERM, and run jobs longer than 2 minutes with RunTask or under task scale-in protection.",
        docs: `${GUIDE}#check-your-host-s-time-limits`,
      });
    }
  }
}

// "SHOPIFY_APP_URL to the container's environment and SHOPIFY_API_SECRET to its secrets"
function add(missing: string[]): string {
  const env = missing.filter((n) => n !== "SHOPIFY_API_SECRET");
  const parts = [env.length ? `${env.join(" and ")} to the container's environment` : "", missing.includes("SHOPIFY_API_SECRET") ? `SHOPIFY_API_SECRET to ${env.length ? "its" : "the container's"} secrets` : ""];
  return parts.filter(Boolean).join(" and ");
}

function shopifyEnvFindings(repo: Repo, defs: TaskDef[], findings: Finding[]) {
  const server = repo.sourceFiles().find((f) => /shopifyApp\s*\(/.test(repo.read(f) ?? ""));
  if (!server) return;
  const serverText = repo.read(server) ?? "";
  const required = ["SHOPIFY_APP_URL", "SHOPIFY_API_KEY", "SHOPIFY_API_SECRET"].filter((n) => serverText.includes(`process.env.${n}`));
  for (const def of defs) {
    for (const c of appContainers(def).filter((c) => !isMigration(repo, c))) {
      // variables from an S3 file, which the repo can't show
      if (Array.isArray(c.node.environmentFiles) && c.node.environmentFiles.length) continue;
      const missing = required.filter((n) => !c.names.has(n));
      if (!missing.length) continue;
      // the library's names for them, in the order its error lists them
      const keys = [missing.includes("SHOPIFY_API_SECRET") && "apiSecretKey", missing.includes("SHOPIFY_API_KEY") && "apiKey"].filter((k): k is string => !!k);
      findings.push({
        id: "aws/shopify-env-missing",
        severity: "error",
        file: def.file,
        line: lineOfContainer(c, c.node.environment ? "environment" : undefined),
        message: `${def.family}'s container ${c.name || "(unnamed)"} gets no ${missing.join(", ")}, and ${server} reads ${missing.length > 1 ? "them" : "it"} when it loads, so a task that imports it exits at startup.`,
        error: keys.length ? `Cannot initialize Shopify API Library. Missing values for: ${keys.join(", ")}` : "Detected an empty appUrl configuration",
        fix: `Add ${add(missing)} in every task definition that loads ${server}, including one-off tasks such as the backfill.`,
        docs: `${GUIDE}#environment-variables`,
      });
    }
  }
}

function startFindings(repo: Repo, defs: TaskDef[], findings: Finding[]) {
  for (const def of defs) {
    for (const c of appContainers(def).filter((c) => c.command && !isMigration(repo, c))) {
      const runs = expandScripts(repo, c.command);
      if (/migrate\s+deploy|db\s+push/.test(runs)) {
        findings.push({
          id: "aws/migrate-on-start",
          severity: "warning",
          file: def.file,
          line: lineOfContainer(c, "command"),
          message: `${def.family} starts with "${c.command}", which runs "${runs}". Every task migrates when it starts, so a scale-out to 60 tasks runs your migrations 60 times, and each new task waits for them before it answers Shopify.`,
          fix: "Start the container with npm run start, or npm run worker, and run migrations once per deploy as a task of their own before the services update.",
          docs: `${GUIDE}#run-migrations-once-per-deploy`,
        });
      }
    }
  }
  for (const def of defs) {
    for (const c of appContainers(def).filter((c) => c.command && !isMigration(repo, c))) {
      const found = startOverrideFindings(repo, "aws", def.file, lineOfContainer(c, "command"), c.command, `${GUIDE}#run-migrations-once-per-deploy`);
      if (found.length) return void findings.push(found[0]);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Row-level security and the migration task

const MIGRATION_COMMAND = /migrat|\bdb\s+push\b/;
const sqlTable = (raw: string) => raw.replace(/"/g, "").split(".").pop()!.toLowerCase();
// "arn:...:secret:my-app/database-url-AbCdEf:password::" and the same ARN without the JSON key name the same secret
const secretArn = (valueFrom: string) => valueFrom.replace(/(:secret:[^:]+):.*$/, "$1");

function secretOf(c: Container, name: string): string | null {
  const entry = (Array.isArray(c.node.secrets) ? c.node.secrets : []).find((s: any) => s?.name === name);
  return entry?.valueFrom ? secretArn(String(entry.valueFrom)) : null;
}

// The task definitions a deploy script runs migrations with: one whose container only migrates, or a
// service's task definition started by run-task with a command override that migrates
function migrationContainers(repo: Repo, defs: TaskDef[], commands: Aws[]): Container[] {
  const out = defs.flatMap((d) => d.containers.filter((c) => isMigration(repo, c) && MIGRATION_COMMAND.test(`${d.family} ${c.command}`)));
  for (const c of commands.filter((c) => isCmd(c, "ecs", "run-task") && /migrat/.test(flag(c, "overrides") ?? ""))) {
    const family = (flag(c, "task-definition") ?? "").replace(/:\d+$/, "");
    const def = defs.find((d) => d.family === family);
    if (def) out.push(...appContainers(def));
  }
  return out;
}

function ownerFindings(repo: Repo, defs: TaskDef[], commands: Aws[], findings: Finding[]) {
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
  const services = defs.flatMap((d) => appContainers(d).filter((c) => !isMigration(repo, c)));
  const reported = new Set<string>();
  for (const migration of migrationContainers(repo, defs, commands)) {
    const secret = secretOf(migration, migrationVar);
    const service = secret && services.find((s) => s.def !== migration.def && secretOf(s, appVar) === secret);
    const sameDef = secret && services.includes(migration);
    if ((!service && !sameDef) || reported.has(migration.def.file)) continue;
    reported.add(migration.def.file);
    const tables = [...new Set(unforced.map((t) => t.table))];
    const who = service ? `${service.def.family} reads ${appVar} from the same secret` : `the migration runs with ${migration.def.family}'s own task definition, so the services read the same secret`;
    findings.push({
      id: "aws/owner-skips-rls",
      severity: "error",
      file: migration.def.file,
      line: lineOfContainer(migration, "secrets"),
      message: `The migration reads ${migrationVar} from the secret ${secret!.replace(/^.*:secret:/, "")}, and ${who}, so the services connect as the master user that runs migrations and owns the tables. Postgres skips row-level security for a table's owner, so the policies on ${tables.join(", ")} (${unforced[0].file}) never apply to them.`,
      error: "a query with no store set returns every store's rows",
      fix: `Give the migration task definition a secret of its own, such as my-app/migrate-database-url, with the postgres URL, and put the URL of an app_user you create with SQL in the services' secret. Then check once as app_user that a query without app.shop_id set fails with unrecognized configuration parameter "app.shop_id" on a fresh connection, or invalid input syntax for type bigint: "" on a reused one, or run scripts/db-check.sql as it.`,
      docs: `${GUIDE}#rewrite-permissions-and-shop-tenancy`,
    });
  }
}

// ECS reads a task's secrets with its execution role. A migration task that shares the services'
// execution role lets that role read the owner's URL, even though the services never load it.
function sharedRoleFindings(repo: Repo, defs: TaskDef[], findings: Finding[]) {
  for (const def of defs.filter((d) => d.containers.some((c) => isMigration(repo, c) && MIGRATION_COMMAND.test(`${d.family} ${c.command}`)))) {
    const role = def.doc.executionRoleArn;
    if (typeof role !== "string" || role.includes("$")) continue;
    const service = defs.find((d) => d !== def && d.doc.executionRoleArn === role && appContainers(d).some((c) => !isMigration(repo, c)));
    if (!service) continue;
    findings.push({
      id: "aws/migrate-shared-role",
      severity: "warning",
      file: def.file,
      line: keyLine(def.doc, "executionRoleArn"),
      message: `${def.family} uses the execution role ${role.replace(/^.*:role\//, "")}, the same as ${service.family}, and ECS reads a task's secrets with its execution role, so that role can read the migration's database URL, the master user's.`,
      fix: "Give the migration task definition an execution role of its own, with secretsmanager:GetSecretValue on the migration secret only, and give no other role access to that secret.",
      docs: `${GUIDE}#rewrite-permissions-and-shop-tenancy`,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Deploy scripts

function migrateDeployFindings(repo: Repo, commands: Aws[], findings: Finding[]) {
  const byFile = new Map<string, Aws[]>();
  for (const c of commands) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);
  for (const [file, list] of byFile) {
    if (!/\.(sh|bash)$/.test(file)) continue;
    const run = list.find((c) => isCmd(c, "ecs", "run-task") && /migrat/.test(`${flag(c, "task-definition") ?? ""} ${flag(c, "overrides") ?? ""}`));
    if (!run) continue;
    const update = list.find((c) => isCmd(c, "ecs", "update-service") && c.line > run.line);
    if (!update) continue;
    const base = { id: "aws/migrate-before-deploy", file, docs: `${GUIDE}#run-migrations-once-per-deploy` } as const;
    const text = repo.read(file) ?? "";
    const between = (c: Aws) => c.line > run.line && c.line < update.line;
    const wait = list.find((c) => isCmd(c, "ecs", "wait", "tasks-stopped") && between(c));
    if (!wait) {
      findings.push({ ...base, severity: "error", line: run.line, message: "This starts the migration task and updates the services without waiting for it, so the new code starts on the old schema, and a failed migration doesn't stop the deploy.", fix: "Wait with aws ecs wait tasks-stopped, then read the container's exitCode with aws ecs describe-tasks and stop the script unless it is 0." });
      continue;
    }
    const checked = list.some((c) => isCmd(c, "ecs", "describe-tasks") && between(c) && /exitCode/.test(flag(c, "query") ?? text.split("\n").slice(c.line - 1, c.line + 3).join("\n")));
    if (!checked) {
      findings.push({ ...base, severity: "error", line: wait.line, message: "aws ecs wait tasks-stopped succeeds once the task stops, whatever its exit code, so a migration that fails, or a task that never starts, still lets the services update onto the old schema.", error: "the wait exits 0 for a task whose exit code is 1, or None", fix: "After the wait, read tasks[0].containers[0].exitCode with aws ecs describe-tasks and exit 1 unless it is 0, as the guide's deploy script does." });
      continue;
    }
    if (!/^\s*set\s+-[a-z]*e|^\s*set\s+-o\s+errexit/m.test(text)) {
      findings.push({ ...base, severity: "warning", line: run.line, message: "The script has no set -e, so a failed run-task or wait doesn't stop the lines that update the services.", fix: "Add set -euo pipefail at the top of the script." });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// RDS and Aurora

function rdsFindings(repo: Repo, commands: Aws[], findings: Finding[]) {
  for (const c of commands.filter((c) => isCmd(c, "rds", "create-db-instance") && !has(c, "db-cluster-identifier") && !/aurora/.test(flag(c, "engine") ?? ""))) {
    const name = flag(c, "db-instance-identifier") ?? "the instance";
    if (!has(c, "storage-encrypted")) {
      findings.push({
        id: "aws/storage-encrypted",
        severity: "warning",
        file: c.file,
        line: c.line,
        message: `This creates ${name} without --storage-encrypted, and the CLI and API create an unencrypted instance by default. Encryption can't be turned on later without restoring a snapshot into a new instance, with a new endpoint.`,
        fix: "Add --storage-encrypted before you load records.",
        docs: `${GUIDE}#map-your-models-to-database-tables`,
      });
    }
    if (!has(c, "backup-retention-period")) {
      findings.push({
        id: "aws/backup-retention",
        severity: "warning",
        file: c.file,
        line: c.line,
        message: `This creates ${name} without --backup-retention-period, so it keeps automated backups for 1 day, where the console defaults to 7, and point-in-time recovery reaches back only that far.`,
        fix: "Add --backup-retention-period 7, or longer, up to 35.",
        docs: `${GUIDE}#map-your-models-to-database-tables`,
      });
    }
  }
  // Aurora Serverless v2 at 0 capacity, in a CLI flag, CloudFormation, Terraform, or CDK
  const patterns: [RegExp, string][] = [
    [/MinCapacity\s*=\s*0(\.0+)?\b(?!\.\d*[1-9])/, "MinCapacity=0"],
    [/["']?MinCapacity["']?\s*:\s*0(\.0+)?\s*[,}\n]/, "MinCapacity: 0"],
    [/\bmin_capacity\s*=\s*0(\.0+)?\s*$/m, "min_capacity = 0"],
    [/\bserverlessV2MinCapacity\s*:\s*0(\.0+)?\s*[,}\n]/, "serverlessV2MinCapacity: 0"],
  ];
  for (const file of repo.files.filter((f) => /\.(sh|bash|ya?ml|json|tf|ts|js|mjs)$/.test(f) && !/(^|\/)package(-lock)?\.json$/.test(f))) {
    const text = repo.read(file) ?? "";
    if (!/MinCapacity|min_capacity/i.test(text) || !/serverless|aurora|ServerlessV2/i.test(text)) continue;
    for (const [pattern, shown] of patterns) {
      const line = lineOf(text, pattern);
      if (line === undefined) continue;
      findings.push({
        id: "aws/serverless-pause",
        severity: "warning",
        file,
        line,
        message: `Aurora Serverless v2 with ${shown} pauses after 5 minutes without connections, and the first query after that waits about 15 seconds, or 30 or more after a day. authenticate.webhook reads the store's session from the database, so a webhook that wakes it misses Shopify's 5-second limit.`,
        error: "Shopify retries the webhook after 5 seconds, and its delivery metrics show timeouts",
        fix: "Keep the minimum capacity above 0 in production, such as 0.5. A staging database can pause.",
        docs: `${GUIDE}#map-your-models-to-database-tables`,
      });
      break;
    }
  }
}

// RDS Proxy pins a session on set_config and session advisory locks, so it shares no connections for an
// app that sets the store in every transaction. Only the proxy's metric can tell.
function proxyFindings(repo: Repo, commands: Aws[], findings: Finding[]) {
  const proxy =
    commands.find((c) => isCmd(c, "rds", "create-db-proxy")) ??
    repo.files.filter((f) => /\.(sh|bash|ya?ml|json|tf|ts|js|env)$|(^|\/)\.env/.test(f) && !/(^|\/)package(-lock)?\.json$/.test(f)).map((f) => ({ file: f, text: repo.read(f) ?? "" })).find((f) => /\.proxy-[a-z0-9]+\.[a-z0-9-]+\.rds\.amazonaws\.com|AWS::RDS::DBProxy\b|"aws_db_proxy"|\baws_db_proxy\b|new\s+(rds\.)?DatabaseProxy\b/.test(f.text));
  if (!proxy) return;
  const where = "positional" in proxy ? `${proxy.file}:${proxy.line}` : proxy.file;
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file) ?? "";
    const code = mask(text, false);
    const hit = /\bset_config\s*\(|\bpg_(try_)?advisory_lock\s*\(/i.exec(code);
    if (!hit) continue;
    findings.push({
      id: "aws/rds-proxy-pinning",
      severity: "manual",
      file,
      line: lineAt(text, hit.index),
      message: `The app connects through RDS Proxy (${where}), and this file runs ${hit[0].replace(/\s*\($/, "(").trim()}...), which pins the client's session to one database connection until it disconnects. An app that sets the store in every transaction pins every session, so each task holds as many connections as it would without the proxy.`,
      fix: "Watch the proxy's DatabaseConnectionsCurrentlySessionPinned metric in CloudWatch on staging. If it matches your connection count, size the pools against max_connections, or run PgBouncer in transaction mode as an ECS service instead. Keep migrations on the instance's own endpoint.",
      docs: `${GUIDE}#connect-through-rds-proxy`,
    });
    return;
  }
}

// ---------------------------------------------------------------------------------------------
// SQS and EventBridge Scheduler

// Queue attributes from --attributes, as JSON or as Key=value pairs
function queueAttributes(value: string | undefined): Record<string, string> | null {
  if (!value) return {};
  const text = value.trim();
  if (text.startsWith("{")) {
    try {
      return Object.fromEntries(Object.entries(JSON.parse(text)).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
    } catch {
      return null;
    }
  }
  if (text.startsWith("file://") || text.includes("$")) return null;
  const out: Record<string, string> = {};
  // RedrivePolicy's value is itself JSON with commas, so split only before Key=
  for (const part of text.split(/,(?=[A-Za-z]+=)/)) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

function sqsFindings(commands: Aws[], findings: Finding[]) {
  const queues = commands
    .filter((c) => isCmd(c, "sqs", "create-queue"))
    .map((c) => ({ c, name: flag(c, "queue-name") ?? "", attributes: queueAttributes(flag(c, "attributes")) }))
    .filter((q) => q.name && !q.name.includes("$"));
  const redrive = (q: (typeof queues)[number]) => {
    const raw = q.attributes?.RedrivePolicy;
    if (!raw) return null;
    try {
      return JSON.parse(raw) as { deadLetterTargetArn?: string };
    } catch {
      return {};
    }
  };
  const targets = new Set(queues.map((q) => redrive(q)?.deadLetterTargetArn?.split(":").pop()).filter(Boolean));
  const retention = (q: (typeof queues)[number] | undefined) => Number(q?.attributes?.MessageRetentionPeriod ?? 345600);
  for (const q of queues) {
    if (!q.attributes) continue;
    const policy = redrive(q);
    if (!policy && !targets.has(q.name) && !/dlq|dead/i.test(q.name)) {
      findings.push({
        id: "aws/sqs-redrive",
        severity: "warning",
        file: q.c.file,
        line: q.c.line,
        message: `The queue ${q.name} has no redrive policy, so a job that always fails comes back after every visibility timeout until the queue's retention ends, 4 days by default. Gadget stopped after 6 retries.`,
        fix: 'Create a dead-letter queue and set RedrivePolicy with maxReceiveCount 7, which counts the first attempt, such as {"deadLetterTargetArn":"arn:aws:sqs:us-east-1:123456789012:jobs-dlq","maxReceiveCount":"7"}.',
        docs: `${GUIDE}#send-jobs-and-run-a-worker`,
      });
      continue;
    }
    const dlqName = policy?.deadLetterTargetArn?.split(":").pop();
    const dlq = queues.find((d) => d.name === dlqName);
    if (dlq?.attributes && retention(dlq) <= retention(q)) {
      findings.push({
        id: "aws/sqs-dlq-retention",
        severity: "warning",
        file: dlq.c.file,
        line: dlq.c.line,
        message: `The dead-letter queue ${dlq.name} keeps messages for ${retention(dlq) / 86400} days, no longer than ${q.name}. A message keeps its original enqueue time when it moves, so one that reaches ${dlq.name} after days of retries is deleted from it soon after, before anyone looks at it.`,
        fix: "Set MessageRetentionPeriod=1209600, 14 days, the most SQS allows, on the dead-letter queue.",
        docs: `${GUIDE}#send-jobs-and-run-a-worker`,
      });
    }
  }
}

// A five-field cron schedule, such as Gadget's 0 2 * * 1, in Scheduler's six fields, with ? in the day field
// it doesn't use and day-of-week numbers moved from 0-6 to 1-7, both starting at Sunday
function sixFields([minute, hour, dom, month, dow]: string[]): string {
  const days = dow.replace(/\d+/g, (n) => String((Number(n) % 7) + 1));
  return dow === "*" ? `cron(${minute} ${hour} ${dom} ${month} ? *)` : `cron(${minute} ${hour} ${dom === "*" ? "?" : dom} ${month} ${days} *)`;
}

// EventBridge cron expressions, such as cron(0 2 * * ? *), in scripts and infrastructure files
function cronFindings(repo: Repo, findings: Finding[]) {
  for (const file of repo.files.filter((f) => /\.(sh|bash|ya?ml|json|tf)$|(^|\/)Makefile$/.test(f) && !/(^|\/)package(-lock)?\.json$/.test(f))) {
    const text = repo.read(file) ?? "";
    for (const m of text.matchAll(/\bcron\(([^()\n]*)\)/g)) {
      const expression = m[0];
      const fields = m[1].trim().split(/\s+/);
      // a variable the script fills in, such as cron($MINUTE 2 * * ? *)
      if (m[1].includes("$")) continue;
      const problem =
        fields.length !== 6
          ? `has ${fields.length} fields. Scheduler's cron has six, the last one a year, so it refuses the command`
          : fields[2] !== "?" && fields[4] !== "?"
            ? "sets both day fields. One of day-of-month and day-of-week must be ?, so Scheduler refuses it"
            : null;
      if (problem) {
        const five = fields.length === 5 ? sixFields(fields) : null;
        const shifted = fields.length === 5 && /\d/.test(fields[4]);
        findings.push({
          id: "aws/scheduler-cron",
          severity: "error",
          file,
          line: lineAt(text, m.index!),
          message: `The schedule expression ${expression} ${problem}.`,
          error: "ValidationException: Invalid Schedule Expression",
          fix: `Write it with six fields and ? in one day field${five ? `, such as ${five} for ${fields.join(" ")}` : ", such as cron(0 2 * * ? *) for 02:00 every day"}.${shifted ? " Scheduler numbers the days of the week 1 to 7 from Sunday, where cron numbers them 0 to 6, so cron's 1, Monday, is Scheduler's 2, and the suggestion adds 1 to each day number." : ""}`,
          docs: `${GUIDE}#replace-scheduled-actions`,
        });
      }
    }
  }
}

function schedulerFindings(commands: Aws[], findings: Finding[]) {
  for (const c of commands.filter((c) => isCmd(c, "scheduler", "create-schedule") || isCmd(c, "scheduler", "update-schedule"))) {
    const name = flag(c, "name") ?? "the schedule";
    const expression = flag(c, "schedule-expression") ?? "";
    const update = c.positional[1] === "update-schedule";
    const missing = (update ? ["schedule-expression", "flexible-time-window", "target"] : ["flexible-time-window"]).filter((n) => !has(c, n));
    if (missing.length) {
      findings.push({
        id: "aws/scheduler-required",
        severity: "error",
        file: c.file,
        line: c.line,
        message: update
          ? `This updates ${name} without ${missing.map((m) => `--${m}`).join(", ")}. update-schedule replaces the whole schedule, so the CLI refuses it, and turning on a schedule you created disabled means sending its whole definition again.`
          : `This creates ${name} without --flexible-time-window, which has no default, so the CLI refuses it at the cutover step where you create schedules.`,
        error: `the following arguments are required: ${missing.map((m) => `--${m}`).join(", ")}`,
        fix: update ? "Send the schedule's expression, time zone, --flexible-time-window Mode=OFF, and --target with the state, as the create command did." : "Add --flexible-time-window Mode=OFF, which sends each run at its scheduled minute.",
        docs: `${GUIDE}#replace-scheduled-actions`,
      });
    }
    const state = flag(c, "state") ?? "ENABLED";
    if (!update && /^(cron|rate)\(/.test(expression) && state.toUpperCase() !== "DISABLED" && !state.includes("$")) {
      findings.push({
        id: "aws/schedule-runs-on-create",
        severity: "manual",
        file: c.file,
        line: c.line,
        message: `${name} runs as soon as it exists, so a script run before the cutover makes it run in both apps until Gadget's scheduler stops.`,
        fix: "Run this in the cutover's Move scheduled work step, or create it with --state DISABLED and send the whole definition with update-schedule --state ENABLED then.",
        docs: `${GUIDE}#cut-over-to-the-new-platform`,
      });
    }
  }
}

// With AWS_ENDPOINT_URL set for a local emulator, the SQS client still sends each call to the host in
// the queue's URL, so development sends the emulator's credentials to AWS.
function sqsEndpointFindings(repo: Repo, findings: Finding[]) {
  const configured = repo.files.some((f) => /(^|\/)(\.env[\w.-]*|docker-compose[\w.-]*\.ya?ml|compose\.ya?ml|package\.json|Makefile|[\w.-]+\.sh)$/.test(f) && /\bAWS_ENDPOINT_URL(_SQS)?\b/.test(repo.read(f) ?? ""));
  if (!configured) return;
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file) ?? "";
    for (const call of calls(text, "\\bnew\\s+SQSClient")) {
      const open = text.indexOf("{", call.open);
      const config = open > 0 && open < call.close ? new Set(props(text, open).map((p) => p.key)) : new Set<string>();
      if (config.has("useQueueUrlAsEndpoint") || config.has("endpoint")) continue;
      findings.push({
        id: "aws/sqs-endpoint",
        severity: "warning",
        file,
        line: lineAt(text, call.index),
        message: "The repo sets AWS_ENDPOINT_URL for a local emulator, and this SQSClient keeps useQueueUrlAsEndpoint on, so each call goes to the host in the queue's URL, such as sqs.us-east-1.amazonaws.com, with the emulator's credentials.",
        error: "InvalidClientTokenId: The security token included in the request is invalid",
        fix: "Create the client with useQueueUrlAsEndpoint: false, such as new SQSClient({ useQueueUrlAsEndpoint: false }), so it uses the configured endpoint.",
        docs: `${GUIDE}#set-up-development-and-deploys`,
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// S3

function presignFindings(repo: Repo, findings: Finding[]) {
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file) ?? "";
    for (const call of calls(text, "\\bgetSignedUrl")) {
      const args = text.slice(call.open + 1, call.close);
      const open = args.lastIndexOf("{");
      if (open < 0) continue;
      const expires = props(text, call.open + 1 + open).find((p) => p.key === "expiresIn");
      const seconds = expires ? arithmetic(expires.value) : null;
      if (seconds === null || seconds <= 3600) continue;
      findings.push({
        id: "aws/presign-expiry",
        severity: "warning",
        file,
        line: lineAt(text, expires!.index),
        message: `This signs a URL for ${seconds / 3600} hours. A URL works until its expiry or until the credentials that signed it expire, whichever comes first, and ECS rotates a task role's credentials every 1 to 6 hours, so a link can stop working minutes after it was made.`,
        error: "ExpiredToken: The provided token has expired.",
        fix: "Sign each link when a page shows the file, with a short expiry such as 15 * 60. For a link you store, such as in a metafield or an email, store the URL of your own route that redirects to a freshly signed one.",
        docs: `${GUIDE}#search-files-and-other-services`,
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------

function serviceFindings(commands: Aws[], findings: Finding[]) {
  for (const c of commands.filter((c) => isCmd(c, "ecs", "create-service") && has(c, "load-balancers") && !has(c, "health-check-grace-period-seconds"))) {
    findings.push({
      id: "aws/health-check-grace",
      severity: "warning",
      file: c.file,
      line: c.line,
      message: `${flag(c, "service-name") ?? "This service"} sits behind a load balancer with no --health-check-grace-period-seconds, which is 0 by default, so ECS replaces a task that fails the health check while the server is still starting, and a deploy can loop.`,
      fix: "Add --health-check-grace-period-seconds 60, or longer than your server's startup, and point the target group's check at a route that doesn't query the database, such as /healthz.",
      docs: `${GUIDE}#receive-webhooks`,
    });
  }
}

const AWS_SDK = ["@aws-sdk/client-sqs", "@aws-sdk/client-ecs", "@aws-sdk/client-scheduler"];

export const aws: CheckModule = {
  platform: "aws",
  title: "AWS",
  detect: (repo) =>
    AWS_SDK.some((p) => p in repo.dependencies()) ||
    repo.files.some((f) => /\.json$/.test(f) && !/(^|\/)package(-lock)?\.json$/.test(f) && /"containerDefinitions"/.test(repo.read(f) ?? "")) ||
    repo.files.some((f) => /\.(sh|bash)$/.test(f) && /\baws\s+(ecs|rds|sqs|scheduler)\s+[a-z]/.test(repo.read(f) ?? "")),
  // When every app container in the task definitions sets a command, ECS never starts the Dockerfile's CMD
  suppresses: (repo) => {
    const defs = taskDefinitions(repo, []);
    const containers = defs.flatMap(appContainers);
    return containers.length > 0 && containers.every((c) => c.command) ? ["common/migrate-on-start"] : [];
  },
  run: (repo) => {
    const findings: Finding[] = [];
    const defs = taskDefinitions(repo, findings);
    const commands = awsCommands(repo);
    stopTimeoutFindings(repo, defs, findings);
    shopifyEnvFindings(repo, defs, findings);
    startFindings(repo, defs, findings);
    ownerFindings(repo, defs, commands, findings);
    sharedRoleFindings(repo, defs, findings);
    migrateDeployFindings(repo, commands, findings);
    rdsFindings(repo, commands, findings);
    proxyFindings(repo, commands, findings);
    sqsFindings(commands, findings);
    cronFindings(repo, findings);
    schedulerFindings(commands, findings);
    sqsEndpointFindings(repo, findings);
    presignFindings(repo, findings);
    serviceFindings(commands, findings);
    return findings;
  },
};
