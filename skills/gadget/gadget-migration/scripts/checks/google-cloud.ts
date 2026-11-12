// Checks for apps moving to Google Cloud. references/platforms/google-cloud.md explains each one.
import { DOCS, type CheckModule, type Finding, type Repo } from "./types.ts";
import { dockerCommand, keyLine, lineAt, lineOf, parseDockerfile, parseYaml } from "./read-config.ts";
import { dockerfileCmd, expandScripts, startOverrideFindings } from "./common.ts";
import { calls, mask } from "./source-scan.ts";
import { arithmetic } from "./railway.ts";
import { prismaUrls } from "./render.ts";

const GUIDE = `${DOCS}/google-cloud`;
const REF = "references/platforms/google-cloud.md";

// ---------------------------------------------------------------------------------------------
// gcloud commands in shell scripts, CI workflows, and cloudbuild.yaml

interface Gcloud {
  file: string;
  line: number;
  // the words after "gcloud", with "beta" and "alpha" dropped
  words: string[];
  flags: Map<string, string[]>;
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
    if (c === "'" || c === '"') {
      const close = text.indexOf(c, i + 1);
      const end = close < 0 ? text.length : close;
      word += text.slice(i + 1, end);
      i = end;
    } else if (c === "$" && text[i + 1] === "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")" && --depth === 0) break;
      }
      word += text.slice(i, j + 1);
      i = j;
    } else {
      word += c;
    }
  }
  endCommand();
  return out;
}

function toGcloud(file: string, line: number, raw: string[]): Gcloud {
  const words = raw.filter((w) => w !== "beta" && w !== "alpha");
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
    if (eq < 0 && i + 1 < words.length && !words[i + 1].startsWith("-") && !BOOLEAN_FLAGS.has(name)) value = words[++i];
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { file, line, words, flags, positional };
}

const BOOLEAN_FLAGS = new Set(["allow-unauthenticated", "no-allow-unauthenticated", "execute-now", "wait", "async", "quiet", "no-traffic", "to-latest", "cpu-throttling", "no-cpu-throttling", "clear-env-vars", "clear-secrets", "cpu-boost", "no-cpu-boost", "enable-connection-pooling", "no-enable-connection-pooling"]);

// Plain NAME=value assignments in a script, so "$SECRETS" in a command can be read. A value that
// uses a variable the script doesn't assign keeps its "$", and the checks treat it as unknown.
function shellVariables(text: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const match of text.matchAll(/^\s*(?:export\s+)?([A-Za-z_]\w*)=("([^"]*)"|'([^']*)'|(\S*))\s*(?:#.*)?$/gm)) {
    vars.set(match[1], match[3] ?? match[4] ?? match[5] ?? "");
  }
  for (let pass = 0; pass < 3; pass++) for (const [name, value] of vars) vars.set(name, substitute(value, vars));
  // "${1:?usage}" or "my-app-${ENV}": a value the script only knows when it runs
  for (const [name, value] of vars) if (value.includes("$")) vars.delete(name);
  return vars;
}

function substitute(word: string, vars: Map<string, string>): string {
  return word.replace(/\$\{(\w+)\}|\$(\w+)/g, (whole, braced, bare) => vars.get(braced ?? bare) ?? whole);
}

function gcloudCommands(repo: Repo): Gcloud[] {
  const out: Gcloud[] = [];
  const files = repo.files.filter((f) => /\.(sh|bash|ya?ml)$|(^|\/)Makefile$/.test(f) && !/(^|\/)(node_modules|test|tests|fixtures)\//.test(f));
  for (const file of files) {
    const text = repo.read(file) ?? "";
    if (!text.includes("gcloud") && !text.includes("cloud-sdk") && !text.includes("cloud-builders")) continue;
    const vars = /\.(sh|bash)$/.test(file) ? shellVariables(text) : new Map<string, string>();
    for (const { words, index } of shellCommands(text)) {
      const at = words.indexOf("gcloud");
      if (at >= 0 && words.length > at + 2) out.push(toGcloud(file, lineAt(text, index), words.slice(at + 1).map((w) => substitute(w, vars))));
    }
    // cloudbuild.yaml steps that run gcloud with an args list
    if (/cloudbuild/.test(file)) {
      let doc: any;
      try {
        doc = parseYaml(text);
      } catch {
        continue;
      }
      for (const step of Array.isArray(doc?.steps) ? doc.steps : []) {
        const gcloudStep = step?.entrypoint === "gcloud" || (!step?.entrypoint && /cloud-builders\/gcloud|cloud-sdk/.test(String(step?.name)));
        if (gcloudStep && Array.isArray(step.args)) out.push(toGcloud(file, keyLine(step, "args") ?? 1, step.args.map(String)));
      }
    }
  }
  return out;
}

const flag = (c: Gcloud, ...names: string[]) => names.map((n) => c.flags.get(n)?.at(-1)).find((v) => v !== undefined);
const has = (c: Gcloud, ...names: string[]) => names.some((n) => c.flags.has(n));
const isCmd = (c: Gcloud, ...prefix: string[]) => prefix.every((p, i) => c.positional[i] === p);
// "gcloud run deploy NAME": the service name
const serviceName = (c: Gcloud) => (isCmd(c, "run", "deploy") ? c.positional[2] : isCmd(c, "run", "jobs", "deploy") || isCmd(c, "run", "jobs", "execute") ? c.positional[3] : undefined);

// Duration flags such as --timeout=15m, --timeout=900, or 1h
function durationSeconds(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  let total = 0;
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)([smhd]?)/g)];
  if (!parts.length) return undefined;
  for (const [, n, unit] of parts) total += Number(n) * { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[unit as "" | "s" | "m" | "h" | "d"];
  return total;
}

// KEY=value lists from --set-env-vars and --set-secrets, including gcloud's ^DELIM^ form
function keyPairs(value: string): [string, string][] {
  let delimiter = ",";
  const custom = value.match(/^\^(.+?)\^/);
  if (custom) {
    delimiter = custom[1];
    value = value.slice(custom[0].length);
  }
  return value.split(delimiter).map((pair): [string, string] => [pair.split("=")[0].trim(), pair.slice(pair.indexOf("=") + 1).trim()]).filter(([key]) => key);
}

function keyList(value: string): string[] {
  return keyPairs(value).map(([key]) => key);
}

// The secret a command sets an environment variable from, such as "database-url" for
// DATABASE_URL=database-url:1, or null when it doesn't set it or the list is a variable the script
// doesn't assign.
function secretFor(c: Gcloud, name: string): string | null {
  for (const value of [...(c.flags.get("set-secrets") ?? []), ...(c.flags.get("update-secrets") ?? [])].reverse()) {
    if (value.includes("$")) continue;
    const ref = keyPairs(value).find(([key]) => key === name)?.[1];
    // "database-url:1" or "projects/123456789/secrets/database-url:1"
    if (ref) return ref.replace(/:[^:/]*$/, "").split("/").pop()!;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------

function shopifyEnvFindings(repo: Repo, commands: Gcloud[], findings: Finding[]) {
  const server = repo.sourceFiles().find((f) => /shopifyApp\s*\(/.test(repo.read(f) ?? ""));
  if (!server) return;
  const serverText = repo.read(server) ?? "";
  const required = ["SHOPIFY_APP_URL", "SHOPIFY_API_KEY", "SHOPIFY_API_SECRET"].filter((n) => serverText.includes(`process.env.${n}`));
  for (const c of commands.filter((c) => isCmd(c, "run", "deploy"))) {
    // without these, the new revision keeps the previous one's variables or secrets, which the files can't show
    const envReplaced = has(c, "set-env-vars", "env-vars-file", "clear-env-vars");
    const secretsReplaced = has(c, "set-secrets", "clear-secrets");
    if (!envReplaced || !secretsReplaced) continue;
    const inline = [...(c.flags.get("set-env-vars") ?? []), ...(c.flags.get("set-secrets") ?? [])];
    // a variable the script doesn't assign: the list can't be read from the files
    if (inline.some((v) => v.includes("$"))) continue;
    const names = new Set(inline.flatMap(keyList));
    // one env vars file, or one per environment for a path such as "${ENV}.env.yaml"
    const envFile = flag(c, "env-vars-file");
    let envFiles: string[] = [];
    if (envFile) {
      const dir = c.file.replace(/[^/]*$/, "");
      const pattern = (p: string) => new RegExp(`^${p.replace(/^\.\//, "").replace(/[.*+?^()|[\]\\]/g, "\\$&").replace(/\$\{?\w+\}?/g, "[\\w.-]+")}$`);
      envFiles = repo.files.filter((f) => pattern(envFile).test(f) || pattern(`${dir}${envFile}`).test(f));
      if (!envFiles.length) continue;
    }
    let unreadable = false;
    const missingFrom = new Map<string, string[]>();
    for (const path of envFiles.length ? envFiles : [""]) {
      const fileNames = new Set(names);
      if (path) {
        try {
          Object.keys(parseYaml(repo.read(path) ?? "") ?? {}).forEach((n) => fileNames.add(n));
        } catch (error) {
          unreadable = true;
          findings.push({
            id: "google-cloud/unreadable-config",
            severity: "manual",
            file: path,
            message: `The checks couldn't read ${path} (${(error as Error).message}), so they couldn't tell which variables ${serviceName(c)} gets.`,
            fix: `Check that it sets ${required.join(", ")}, as ${REF} describes.`,
          });
          continue;
        }
      }
      const missing = required.filter((n) => !fileNames.has(n));
      if (missing.length) missingFrom.set(path, missing);
    }
    if (unreadable || !missingFrom.size) continue;
    const [path, missing] = [...missingFrom][0];
    findings.push({
      id: "google-cloud/shopify-env-missing",
      severity: "error",
      file: c.file,
      line: c.line,
      message: `This deploys ${serviceName(c)} without ${missing.join(", ")}${path ? ` (not in ${path} or its secrets)` : ""}. ${server} reads them when it loads, and every service built from the image loads it, so no revision of ${serviceName(c)} starts.`,
      error: missing.includes("SHOPIFY_APP_URL") ? "Detected an empty appUrl configuration" : `Missing values for: ${missing.map((n) => (n === "SHOPIFY_API_KEY" ? "apiKey" : "apiSecretKey")).join(", ")}`,
      fix: `Add ${missing.join(", ")} to this service's env vars file or secrets, the same as the web service's.`,
      docs: `${GUIDE}#run-migrations-once-per-deploy`,
    });
  }
}

function secretFindings(commands: Gcloud[], findings: Finding[]) {
  for (const c of commands) {
    const values = [...(c.flags.get("set-secrets") ?? []), ...(c.flags.get("update-secrets") ?? [])];
    const latest = values.flatMap((v) => v.split(",")).filter((pair) => /:latest$/.test(pair.trim()));
    if (!latest.length) continue;
    findings.push({
      id: "google-cloud/secret-latest",
      severity: "warning",
      file: c.file,
      line: c.line,
      message: `${latest.map((p) => p.split("=")[0]).join(", ")} ${latest.length > 1 ? "are" : "is"} read as latest. Cloud Run reads a secret when an instance starts, so after you add a version, old and new instances send different values until every old one stops.`,
      fix: "Pin each secret to a version, such as shopify-api-secret:2, and deploy a new revision to change it.",
      docs: `${GUIDE}#environment-variables`,
    });
  }
}

// Cloud Tasks' longest dispatch deadline for an HTTP target
const MAX_DEADLINE = 1800;

// The seconds a dispatchDeadline expression holds: a number expression such as 15 * 60, or names of
// constants the same file defines that way. Null when the file doesn't say.
function deadlineSeconds(text: string, expression: string, depth = 0): number | null {
  const unquoted = expression.trim().replace(/^(["'])(\d+)\1$/, "$2");
  let unknown = false;
  const substituted = unquoted.replace(/(?<![\w$])[A-Za-z_$][\w$]*/g, (name) => {
    const value = depth < 3 ? text.match(new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, "\\$")}\\s*(?::\\s*\\w+\\s*)?=\\s*([^;\\n]+)`))?.[1] : undefined;
    const seconds = value === undefined ? null : deadlineSeconds(text, value, depth + 1);
    if (seconds === null) unknown = true;
    return String(seconds);
  });
  return unknown ? null : arithmetic(substituted);
}

function timeoutFindings(repo: Repo, commands: Gcloud[], findings: Finding[]) {
  const sources = repo.sourceFiles().filter((f) => /createTask\s*\(/.test(repo.read(f) ?? ""));
  if (!sources.length) return;
  const worker =
    commands.find((c) => isCmd(c, "run", "deploy") && has(c, "no-allow-unauthenticated")) ??
    commands.find((c) => isCmd(c, "run", "deploy") && /worker/.test(serviceName(c) ?? ""));
  if (!worker) return;
  const timeout = durationSeconds(flag(worker, "timeout")) ?? 300;
  // the longest dispatch deadline the code sets, or Cloud Tasks' default of 10 minutes
  let deadline = 600;
  let where = { file: sources[0], line: lineOf(repo.read(sources[0]) ?? "", /createTask\s*\(/) };
  let set = false;
  let unread: { file: string; line: number; expression: string } | null = null;
  for (const file of sources) {
    const text = repo.read(file) ?? "";
    for (const match of text.matchAll(/dispatchDeadline\s*:\s*(\{\s*seconds\s*:\s*([^,}\n]+)|[^,}\n]+)/g)) {
      const value = match[2] === undefined ? null : deadlineSeconds(text, match[2]);
      if (value === null) {
        unread ??= { file, line: lineAt(text, match.index!), expression: (match[2] ?? match[1]).trim() };
        continue;
      }
      if (!set || value > deadline) {
        deadline = value;
        where = { file, line: lineAt(text, match.index!) };
        set = true;
      }
    }
  }
  const minutes = (s: number) => (s % 60 === 0 ? `${s / 60} minutes` : `${s} seconds`);
  const flagValue = (s: number) => minutes(s).replace(" minutes", "m").replace(" seconds", "s");
  if (unread) {
    findings.push({
      id: "google-cloud/timeout-deadline",
      severity: "manual",
      file: unread.file,
      line: unread.line,
      message: `The dispatch deadline is ${unread.expression}, which the script can't work out, so it couldn't compare it with ${serviceName(worker)}'s ${minutes(timeout)} --timeout.`,
      fix: `Check that the deadline matches the worker's --timeout, at most 30 minutes: a shorter deadline retries a job while the first copy still runs, and a longer one gets a 504 at ${minutes(timeout)}.`,
      docs: `${GUIDE}#check-your-host-s-time-limits`,
    });
  } else if (deadline < timeout && deadline >= MAX_DEADLINE) {
    findings.push({
      id: "google-cloud/timeout-deadline",
      severity: "warning",
      file: worker.file,
      line: worker.line,
      message: `Cloud Tasks waits ${minutes(deadline)} for a response, the most it allows, and ${serviceName(worker)} lets a request run ${minutes(timeout)}. A job that runs past ${minutes(deadline)} is retried while Cloud Run keeps running the first copy, so two copies run at once.`,
      error: "DEADLINE_EXCEEDED",
      fix: `Lower ${serviceName(worker)}'s --timeout to ${flagValue(deadline)} to match the deadline, and split jobs that run longer than that.`,
      docs: `${GUIDE}#check-your-host-s-time-limits`,
    });
  } else if (deadline < timeout) {
    findings.push({
      id: "google-cloud/timeout-deadline",
      severity: "error",
      file: where.file,
      line: where.line,
      message: `Cloud Tasks waits ${minutes(deadline)} for a response${set ? "" : " (its default)"}, and ${serviceName(worker)} lets a request run ${minutes(timeout)}. A job that runs past ${minutes(deadline)} is retried while Cloud Run keeps running the first copy, so two copies run at once.`,
      error: "DEADLINE_EXCEEDED",
      fix: timeout > MAX_DEADLINE
        ? `Set dispatchDeadline: { seconds: ${MAX_DEADLINE} }, the most Cloud Tasks allows, and lower the worker's --timeout to 30m to match.`
        : `Set dispatchDeadline above your longest job and at or above the worker's --timeout, such as dispatchDeadline: { seconds: ${timeout} } (30 minutes at most).`,
      docs: `${GUIDE}#check-your-host-s-time-limits`,
    });
  } else if (deadline > timeout) {
    findings.push({
      id: "google-cloud/timeout-deadline",
      severity: "warning",
      file: worker.file,
      line: worker.line,
      message: `Tasks wait up to ${minutes(deadline)} for a response, and ${serviceName(worker)} ends a request after ${minutes(timeout)}${flag(worker, "timeout") ? "" : " (Cloud Run's default)"}. A job that runs longer gets a 504 at ${minutes(timeout)} and is retried from the start, failing at the same point every time.`,
      error: "504",
      fix: `Deploy ${serviceName(worker)} with --timeout=${flagValue(deadline)} or more, matching the dispatch deadline.`,
      docs: `${GUIDE}#check-your-host-s-time-limits`,
    });
  }
}

function startFindings(repo: Repo, commands: Gcloud[], findings: Finding[]) {
  const dockerfile = repo.read("Dockerfile");
  if (!dockerfile) return;
  // a start script that runs migrations, such as Shopify's Cloud Run guide's start.sh
  const steps = parseDockerfile(dockerfile);
  const start = steps.filter((s) => s.instruction === "CMD" || s.instruction === "ENTRYPOINT").map((s) => dockerCommand(s.args)).join(" ");
  for (const script of start.match(/[\w./-]+\.sh\b/g) ?? []) {
    const path = [script, script.replace(/^\/app\//, ""), script.replace(/^\.?\//, "")].find((p) => repo.exists(p));
    if (!path) continue;
    const text = repo.read(path) ?? "";
    const expanded = expandScripts(repo, text);
    const match = expanded.match(/prisma\s+db\s+push|migrate\s+deploy/);
    if (!match) continue;
    findings.push({
      id: "google-cloud/migrate-on-start",
      severity: "warning",
      file: path,
      line: lineOf(text, /prisma\s+db\s+push|migrate\s+deploy|npm run \w+/),
      message: `The image starts with ${path}, which runs "${match[0]}" every time an instance starts. A burst of webhooks that starts 40 instances changes the schema 40 times, and each new instance waits for it before it answers Shopify.`,
      fix: "Start the server with npm run start, and run migrations once per deploy as a Cloud Run job before the services deploy.",
      docs: `${GUIDE}#rebuild-the-shopify-connection`,
    });
  }
  const cmd = dockerfileCmd(repo);
  if (cmd) {
    // a start script's own lines count as part of the command, such as one that runs prisma generate
    const scripts = (cmd.command.match(/[\w./-]+\.sh\b/g) ?? []).map((p) => [p, p.replace(/^\/app\//, ""), p.replace(/^\.?\//, "")].find((x) => repo.exists(x))).filter((p): p is string => !!p);
    const generates = scripts.some((p) => /prisma\s+generate/.test(expandScripts(repo, repo.read(p) ?? "")));
    if (!generates) findings.push(...startOverrideFindings(repo, "google-cloud", "Dockerfile", cmd.line, cmd.command, `${GUIDE}#rebuild-the-shopify-connection`).slice(0, 1));
  }
  for (const c of commands.filter((c) => isCmd(c, "run", "deploy") && has(c, "command"))) {
    const command = [flag(c, "command"), ...(flag(c, "args") ?? "").split(",")].join(" ").trim();
    if (findings.some((f) => f.id === "google-cloud/prisma-generate")) break;
    findings.push(...startOverrideFindings(repo, "google-cloud", c.file, c.line, command, `${GUIDE}#rebuild-the-shopify-connection`));
  }
}

// The roles each feature needs, and whether the repo's IAM setup grants them
function iamFindings(repo: Repo, commands: Gcloud[], findings: Finding[]) {
  const needs: { role: string; why: string; file: string; line?: number }[] = [];
  const need = (role: string, why: string, file: string, line?: number) => {
    if (!needs.some((n) => n.role === role)) needs.push({ role, why, file, line });
  };
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file) ?? "";
    if (/createTask\s*\(/.test(text)) {
      need("roles/cloudtasks.enqueuer", "to create tasks", file, lineOf(text, /createTask\s*\(/));
      if (/oidcToken/.test(text)) {
        need("roles/iam.serviceAccountUser", "for the services and the Cloud Tasks service agent to act as the account in oidcToken", file, lineOf(text, /oidcToken/));
        need("roles/run.invoker", "for the oidcToken account to call the private worker", file, lineOf(text, /oidcToken/));
      }
    }
    if (/createQueue\s*\(/.test(text)) need("roles/cloudtasks.queueAdmin", "to create a queue per store; Cloud Tasks Enqueuer can't create queues", file, lineOf(text, /createQueue\s*\(/));
    if (/getSignedUrl\s*\(/.test(text) && /@google-cloud\/storage/.test(text)) {
      need("roles/iam.serviceAccountTokenCreator", "on the service's own account, to sign URLs without a key file", file, lineOf(text, /getSignedUrl\s*\(/));
    }
  }
  for (const c of commands) {
    if (has(c, "add-cloudsql-instances", "set-cloudsql-instances")) need("roles/cloudsql.client", "for the built-in Cloud SQL connection", c.file, c.line);
    if (has(c, "set-secrets", "update-secrets")) need("roles/secretmanager.secretAccessor", "to read the secrets the services get", c.file, c.line);
    if (has(c, "dead-letter-topic")) {
      need("roles/pubsub.publisher", "for the Pub/Sub service agent to move failed messages to the dead-letter topic", c.file, c.line);
      need("roles/pubsub.subscriber", "for the Pub/Sub service agent to remove failed messages from the subscription", c.file, c.line);
    }
  }
  if (!needs.length) return;
  const iamFiles = repo.files.filter((f) => /\.(sh|bash|ya?ml|tf|json)$/.test(f) && !/(^|\/)(node_modules|test|tests|fixtures)\/|package(-lock)?\.json$/.test(f) && /add-iam-policy-binding|google_\w+_iam_(member|binding)/.test(repo.read(f) ?? ""));
  if (!iamFiles.length) {
    findings.push({
      id: "google-cloud/iam-roles",
      severity: "manual",
      message: `The app needs these roles, and no IAM script or Terraform in the repository grants them: ${needs.map((n) => `${n.role} (${n.why})`).join("; ")}.`,
      fix: 'Check each account with gcloud projects get-iam-policy PROJECT_ID --flatten=bindings --filter="bindings.members:serviceAccount:ACCOUNT_EMAIL" --format="value(bindings.role)", plus gcloud run services get-iam-policy my-app-worker and gcloud iam service-accounts get-iam-policy for roles granted on one resource.',
      docs: `${GUIDE}#replace-background-and-scheduled-actions`,
    });
    return;
  }
  const granted = new Set(iamFiles.flatMap((f) => [...(repo.read(f) ?? "").matchAll(/roles\/[\w.]+/g)].map((m) => m[0])));
  for (const n of needs.filter((n) => !granted.has(n.role))) {
    findings.push({
      id: "google-cloud/iam-roles",
      severity: "warning",
      file: n.file,
      line: n.line,
      message: `This needs ${n.role} ${n.why}, and ${iamFiles.join(", ")} never grants it.`,
      error: "PERMISSION_DENIED",
      fix: `Grant ${n.role} in ${iamFiles[0]}, as the IAM script in ${REF} does.`,
      docs: `${GUIDE}#replace-background-and-scheduled-actions`,
    });
  }
}

function queueFindings(repo: Repo, findings: Finding[]) {
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file) ?? "";
    if (!/\.deleteQueue\s*\(/.test(text)) continue;
    findings.push({
      id: "google-cloud/delete-queue",
      severity: "warning",
      file,
      line: lineOf(text, /\.deleteQueue\s*\(/),
      message: "This deletes a Cloud Tasks queue. A deleted queue's name can't be used again for 3 days, so a store that uninstalls and reinstalls within 3 days gets no queue, and every job for it fails.",
      fix: "Keep a store's queue when it uninstalls. Pause it with pauseQueue if it must stop taking jobs.",
      docs: `${GUIDE}#limit-concurrency-per-store`,
    });
  }
}

function pubsubFindings(commands: Gcloud[], findings: Finding[]) {
  for (const c of commands.filter((c) => isCmd(c, "pubsub", "subscriptions", "create") && !has(c, "expiration-period"))) {
    findings.push({
      id: "google-cloud/pubsub-expiration",
      severity: "warning",
      file: c.file,
      line: c.line,
      message: `The subscription ${c.positional[3] ?? ""} has no --expiration-period, so Pub/Sub deletes it after 31 days without activity, and the topic drops every message after that.`,
      fix: "Add --expiration-period=never.",
      docs: `${GUIDE}#receive-webhooks-through-pub-sub`,
    });
  }
}

function scalingFindings(commands: Gcloud[], findings: Finding[]) {
  for (const c of commands.filter((c) => isCmd(c, "run", "deploy") && has(c, "allow-unauthenticated"))) {
    const missing = [!has(c, "min", "min-instances") && "--min", !has(c, "max", "max-instances") && "--max"].filter(Boolean);
    if (!missing.length) continue;
    const name = serviceName(c);
    findings.push({
      id: "google-cloud/instance-limits",
      severity: "manual",
      file: c.file,
      line: c.line,
      message: `This deploys the public service ${name} without ${missing.join(" or ")}, so it keeps whatever the service had before. With no minimum, the first webhook after a quiet period waits for an instance to start; with no maximum, Cloud Run can run 100 instances, each with its own database pool.`,
      fix: `Run gcloud run services describe ${name} --region=REGION --format=yaml and check the minScale and maxScale annotations, or add --min=1 and a --max that keeps instances times pool size under max_connections.`,
      docs: `${GUIDE}#receive-webhooks`,
    });
  }
}

function resolveImport(repo: Repo, from: string, specifier: string): string | undefined {
  const parts = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  const base = parts.join("/").replace(/\.js$/, "");
  return [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`].find((p) => repo.exists(p));
}

function taskRouteFindings(repo: Repo, findings: Finding[]) {
  for (const file of repo.find(/^app\/routes\/(tasks|schedules|pubsub)[.\/][^/]*\.(ts|tsx|js|jsx)$/)) {
    const text = repo.read(file) ?? "";
    if (!/export\s+(const|async function|function)\s+action\b/.test(text)) continue;
    if (/K_SERVICE|verifyIdToken|OAuth2Client|authorization/i.test(text)) continue;
    // a helper it imports, such as workerTask() in app/tasks.server.ts, can do the check instead
    const imports = [...text.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)].map((m) => resolveImport(repo, file, m[1]));
    if (imports.some((f) => f && /K_SERVICE/.test(repo.read(f) ?? ""))) continue;
    findings.push({
      id: "google-cloud/task-route-public",
      severity: "warning",
      file,
      line: lineOf(text, /export\s+(const|async function|function)\s+action\b/),
      message: "Both services run the same image, so this task route also answers on the public web service, where anyone can POST a job to it without a Google-signed token.",
      fix: 'Return 404 unless process.env.K_SERVICE is the worker\'s name, such as if (process.env.K_SERVICE !== "my-app-worker") return new Response(null, { status: 404 }).',
      docs: `${GUIDE}#create-tasks-from-your-app`,
    });
  }
}

function migrateJobFindings(repo: Repo, commands: Gcloud[], findings: Finding[]) {
  const byFile = new Map<string, Gcloud[]>();
  for (const c of commands) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);
  for (const [file, list] of byFile) {
    if (!/\.(sh|bash)$/.test(file)) continue;
    const migrate = list.find((c) => (isCmd(c, "run", "jobs", "deploy") || isCmd(c, "run", "jobs", "execute")) && /migrate/.test(c.words.join(" ")));
    if (!migrate) continue;
    const deploys = list.filter((c) => isCmd(c, "run", "deploy") && c.line > migrate.line);
    if (!deploys.length) continue;
    const name = serviceName(migrate);
    // --wait implies --execute-now on jobs deploy
    const runs = list.find((c) => (isCmd(c, "run", "jobs", "deploy") && has(c, "execute-now", "wait")) || (isCmd(c, "run", "jobs", "execute") && serviceName(c) === name));
    const text = repo.read(file) ?? "";
    const base = { id: "google-cloud/migrate-before-deploy", file, docs: `${GUIDE}#run-migrations-once-per-deploy` } as const;
    if (!runs) {
      findings.push({ ...base, severity: "error", line: migrate.line, message: `This deploys the job ${name} but never runs it, so the services deploy without their migrations.`, fix: "Add --execute-now --wait to the jobs deploy command, or run gcloud run jobs execute with --wait before the services deploy." });
    } else if (!has(runs, "wait")) {
      findings.push({ ...base, severity: "error", line: runs.line, message: `This starts ${name} without --wait, so gcloud returns as soon as the execution starts. The services deploy while migrations still run, and a failed migration doesn't stop the script.`, fix: "Add --wait, so the script waits for the migrations to finish." });
    } else if (!/^\s*set\s+-[a-z]*e|^\s*set\s+-o\s+errexit/m.test(text)) {
      findings.push({ ...base, severity: "warning", line: runs.line, message: "The script has no set -e, so when the migration job fails, the next lines still deploy the new code onto the old schema.", fix: "Add set -euo pipefail at the top of the script." });
    }
  }
}

const MIGRATION_COMMAND = /migrat|\bdb[\s,:]push\b/;
const sqlTable = (raw: string) => raw.replace(/"/g, "").split(".").pop()!.toLowerCase();

// Row-level security that never runs: the services read their database URL from the secret the
// migration job uses, so they connect as the user that owns the tables, and Postgres skips the
// policies for a table's owner.
function ownerFindings(repo: Repo, commands: Gcloud[], findings: Finding[]) {
  const protectedTables: { file: string; table: string }[] = [];
  const forced = new Set<string>();
  for (const file of repo.find(/\.sql$/)) {
    // comments blanked, so a commented-out statement doesn't count
    const sql = (repo.read(file) ?? "").replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
    for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w."]+)\s+force\s+row\s+level\s+security/gi)) forced.add(sqlTable(m[1]));
    for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w."]+)\s+enable\s+row\s+level\s+security|create\s+policy\s+(?:"[^"]+"|[\w$]+)\s+on\s+(?:only\s+)?([\w."]+)/gi)) {
      protectedTables.push({ file, table: sqlTable(m[1] ?? m[2]) });
    }
  }
  const unforced = protectedTables.filter((t) => !forced.has(t.table));
  if (!unforced.length) return;
  // Prisma Migrate connects with directUrl when the schema has one
  const { url, directUrl } = prismaUrls(repo);
  const appVar = url ?? "DATABASE_URL";
  const migrationVar = directUrl ?? appVar;
  const jobs = commands.filter((c) => isCmd(c, "run", "jobs") && ["deploy", "create", "update"].includes(c.positional[2]) && MIGRATION_COMMAND.test([flag(c, "command") ?? "", ...(c.flags.get("args") ?? [])].join(" ")));
  for (const job of jobs) {
    const secret = secretFor(job, migrationVar);
    const service = secret && commands.find((c) => isCmd(c, "run", "deploy") && secretFor(c, appVar) === secret);
    if (!service) continue;
    const tables = [...new Set(unforced.map((t) => t.table))];
    findings.push({
      id: "google-cloud/owner-skips-rls",
      severity: "error",
      file: job.file,
      line: job.line,
      message: `The migration job ${job.positional[3]} reads ${migrationVar} from the secret ${secret}, and ${serviceName(service)} reads ${appVar} from the same secret, so the services connect as the user that runs migrations and owns the tables. Postgres skips row-level security for a table's owner, so the policies on ${tables.join(", ")} (${unforced[0].file}) never apply to them.`,
      error: "a query with no store set returns every store's rows",
      fix: `Give ${job.positional[3]} a second secret, such as migrate-database-url, with the postgres URL, and put the URL of an app role you create with SQL in ${secret}, as the guide's section shows. Then check once as that role that a query without app.shop_id set fails with unrecognized configuration parameter "app.shop_id" on a fresh connection, or invalid input syntax for type bigint: "" on a reused one, or run scripts/db-check.sql as it.`,
      docs: `${GUIDE}#rewrite-permissions-and-shop-tenancy`,
    });
  }
}

// The migration job reads the owner's URL. When it runs as the same service account as a service, that
// service's account can read the migration secret too, even though the service never loads it.
function sharedAccountFindings(commands: Gcloud[], findings: Finding[]) {
  const jobs = commands.filter((c) => isCmd(c, "run", "jobs") && ["deploy", "create", "update"].includes(c.positional[2]) && MIGRATION_COMMAND.test([flag(c, "command") ?? "", ...(c.flags.get("args") ?? [])].join(" ")));
  for (const job of jobs) {
    const account = flag(job, "service-account");
    if (!account) continue;
    const service = commands.find((c) => isCmd(c, "run", "deploy") && flag(c, "service-account") === account);
    if (!service) continue;
    findings.push({
      id: "google-cloud/migrate-shared-account",
      severity: "warning",
      file: job.file,
      line: job.line,
      message: `The migration job ${job.positional[3]} runs as ${account}, the same account as ${serviceName(service)}, so that account can read the migration job's secret, the URL of the user that owns the tables.`,
      fix: "Run the migration job as its own service account, with roles/cloudsql.client and Secret Accessor on the migration secret only, and give no other account access to that secret.",
      docs: `${GUIDE}#rewrite-permissions-and-shop-tenancy`,
    });
  }
}

function sqlUserFindings(commands: Gcloud[], findings: Finding[]) {
  // IAM database users (--type=cloud_iam_user and the like) aren't what the guide describes
  for (const c of commands.filter((c) => isCmd(c, "sql", "users", "create") && /^(built_in)?$/i.test(flag(c, "type") ?? ""))) {
    findings.push({
      id: "google-cloud/sql-user-create",
      severity: "warning",
      file: c.file,
      line: c.line,
      message: `This creates ${c.positional[3] ?? "a database user"} with gcloud sql users create. By default, Cloud SQL gives each user it creates the CREATEROLE and CREATEDB attributes and adds it to cloudsqlsuperuser, and the app's role needs neither.`,
      fix: "Create the app's role with SQL as postgres, with create role, the grants, and alter default privileges as the guide's section shows, and remove this command.",
      docs: `${GUIDE}#rewrite-permissions-and-shop-tenancy`,
    });
  }
}

// Memorystore for Redis defaults to volatile-lru, which evicts BullMQ's keys when memory fills.
// A later update to noeviction anywhere in the repo counts.
function memorystoreFindings(repo: Repo, commands: Gcloud[], findings: Finding[]) {
  if (!repo.dependencies().bullmq) return;
  const policy = (value: string | undefined) => value?.match(/(?:^|,)maxmemory-policy=([\w-]+)/)?.[1];
  const fixed = commands.some((c) => isCmd(c, "redis", "instances", "update") && policy(flag(c, "update-redis-config")) === "noeviction");
  for (const c of commands.filter((c) => isCmd(c, "redis", "instances", "create"))) {
    const set = policy(flag(c, "redis-config"));
    if (set === "noeviction" || fixed) continue;
    const name = c.positional[3] ? `${c.positional[3]} ` : "";
    findings.push({
      id: "google-cloud/memorystore-eviction",
      severity: "error",
      file: c.file,
      line: c.line,
      message: `This creates Memorystore instance ${name}${set ? `with maxmemory-policy ${set}` : "without a maxmemory-policy, so it gets Memorystore's default, volatile-lru"}. Redis then deletes queued BullMQ jobs when its memory is full, and every add still succeeds.`,
      error: 'IMPORTANT! Eviction policy is volatile-lru. It should be "noeviction"',
      fix: "Add --redis-config=maxmemory-policy=noeviction, or run gcloud redis instances update with --update-redis-config=maxmemory-policy=noeviction on the existing instance.",
      docs: `${GUIDE}#replace-background-and-scheduled-actions`,
    });
  }
}

// Managed Connection Pooling, turned on by a gcloud sql or alloydb command in the repo. Pooling
// turned on in the console is invisible here, so these checks stay silent then.
const poolingOn = (commands: Gcloud[]) => commands.find((c) => (isCmd(c, "sql", "instances") || isCmd(c, "alloydb", "instances")) && has(c, "enable-connection-pooling"));
const usesBuiltInConnection = (c: Gcloud) => has(c, "add-cloudsql-instances", "set-cloudsql-instances");

function poolingFindings(repo: Repo, commands: Gcloud[], findings: Finding[]) {
  const pooling = poolingOn(commands);
  if (!pooling) return;
  const where = `${pooling.file}:${pooling.line}`;
  // Cloud Run gen1 embeds Auth Proxy v1, and pooling needs 2.15.2 or later. Jobs and worker pools are always gen2.
  for (const c of commands.filter((c) => isCmd(c, "run", "deploy") && usesBuiltInConnection(c) && flag(c, "execution-environment") !== "gen2")) {
    findings.push({
      id: "google-cloud/pooling-gen1",
      severity: "warning",
      file: c.file,
      line: c.line,
      message: `${where} turns on Managed Connection Pooling, which works only with Cloud SQL Auth Proxy 2.15.2 or later. ${serviceName(c)} uses the built-in connection without --execution-environment=gen2, and a service in the first-generation environment gets Auth Proxy v1.`,
      fix: "Add --execution-environment=gen2 to every service that uses --add-cloudsql-instances, deploy it before you turn pooling on, and check its connections on staging.",
      docs: `${GUIDE}#limit-connections-from-cloud-run`,
    });
  }
  // Prisma Migrate holds a session advisory lock for its whole run, which a transaction pool leaves behind
  for (const c of commands.filter((c) => (isCmd(c, "run", "jobs", "deploy") || isCmd(c, "run", "jobs", "create")) && /migrate|db[\s,]push/.test(c.words.join(" ")) && usesBuiltInConnection(c))) {
    findings.push({
      id: "google-cloud/migrate-through-pool",
      severity: "warning",
      file: c.file,
      line: c.line,
      message: `${where} turns on Managed Connection Pooling, and ${serviceName(c) ?? c.positional[3]} reaches the database through the built-in connection, which then goes through the pool. A migrate deploy there can leave Prisma's advisory lock held on a pooled connection, and the next deploy times out, even over a direct connection.`,
      error: "Timed out trying to acquire a postgres advisory lock (SELECT pg_advisory_lock(72707369)). Timeout: 10000ms.",
      fix: "Replace --set-cloudsql-instances on the migration job with Direct VPC egress (--network and --subnet) and a migrate-database-url version that points at the instance's private address on port 5432. To clear a lock already left, run select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and objid = 72707369 as postgres.",
      docs: `${GUIDE}#run-migrations-once-per-deploy`,
    });
  }
  // Graphile Worker, or the app's own LISTEN, needs a session that a transaction pool doesn't keep
  const listeners: { file: string; line: number; what: string }[] = [];
  if (repo.dependencies()["graphile-worker"]) listeners.push({ file: "package.json", line: lineOf(repo.read("package.json") ?? "", /"graphile-worker"/), what: "Graphile Worker, which learns about new jobs through LISTEN," });
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file) ?? "";
    const m = /["'`]\s*LISTEN\s+[\w"]+\s*;?\s*["'`]/.exec(text) ?? /\.on\(\s*["']notification["']/.exec(text);
    if (m) listeners.push({ file, line: lineAt(text, m.index), what: "This code, which uses LISTEN and NOTIFY," });
  }
  for (const l of listeners) {
    findings.push({
      id: "google-cloud/listen-through-pool",
      severity: "warning",
      file: l.file,
      line: l.line,
      message: `${l.what} needs a connection that stays its own between transactions, and ${where} turns on Managed Connection Pooling, which pools by transaction. Through the pool, a listener stops hearing notifications.`,
      fix: "Give the workers that listen a direct connection to the database, such as Direct VPC egress to the instance's private address on port 5432, and keep the pooled URL for everything else.",
      docs: `${GUIDE}#replace-background-and-scheduled-actions`,
    });
  }
}

// Google blocks outbound port 25 from Compute Engine and Cloud Run functions, and doesn't document it for Cloud Run services.
function smtpFindings(repo: Repo, findings: Finding[]) {
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file) ?? "";
    const call = [...calls(text, "createTransport"), ...calls(text, "setTransport")].find((c) => /\bport\s*:\s*["']?25\b(?!\d)/.test(text.slice(c.open, c.close)));
    const url = /["'`]smtps?:\/\/[^"'`\s]*:25(?![\d])/.exec(text);
    const index = call?.index ?? url?.index;
    if (index === undefined) continue;
    findings.push({
      id: "google-cloud/smtp-port-25",
      severity: "warning",
      file,
      line: lineAt(text, index),
      message: "This sends email over SMTP on port 25. Google Cloud blocks outbound connections to port 25 from Compute Engine, GKE nodes, and Cloud Run functions, and Cloud Run's docs don't say it's open for services.",
      fix: "Use your email provider's port 587 or 465, or its HTTP API.",
      docs: `${GUIDE}#email-and-custom-domains`,
    });
  }
}

// A scheduled route that names its task from the handler's clock: a retry that crosses midnight
// takes the next day's name. Cloud Scheduler sends the run's own time in X-CloudScheduler-ScheduleTime.
const CLOCK = /new Date\(\s*\)|Date\.now\(\s*\)/;
function scheduleNameFindings(repo: Repo, findings: Finding[]) {
  for (const file of repo.find(/^app\/routes\/schedules[.\/][^/]*\.(ts|tsx|js|jsx)$/)) {
    const text = repo.read(file) ?? "";
    if (/x-cloudscheduler-scheduletime/i.test(text)) continue;
    const code = mask(text, false);
    // names assigned from the clock, such as const day = new Date().toISOString().slice(0, 10)
    const fromClock = new Set([...code.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*([^;\n]*)/g)].filter((m) => CLOCK.test(m[2])).map((m) => m[1]));
    const property = [...code.matchAll(/\b(key|name|id|taskName)\s*:\s*([^,}\n]*)/g)].find(
      (m) => CLOCK.test(m[2]) || [...fromClock].some((v) => new RegExp(`\\$\\{\\s*${v}\\b|\\b${v}\\b`).test(m[2]))
    );
    if (!property) continue;
    findings.push({
      id: "google-cloud/schedule-name-from-clock",
      severity: "warning",
      file,
      line: lineAt(text, property.index!),
      message: "This scheduled route names its task from the handler's clock. A run that Cloud Scheduler retries after midnight takes the next day's name, so its work runs twice and the next day's run finds the name taken.",
      fix: 'Build the name from the run\'s scheduled time, request.headers.get("X-CloudScheduler-ScheduleTime"), which every retry of the run repeats, and hash it with createHash("sha256") before it becomes a task name.',
      docs: `${GUIDE}#replace-scheduled-actions`,
    });
  }
}

// Cloud Tasks warns that sequential task names, such as timestamps or increasing ids, slow it down.
function taskNameFindings(repo: Repo, findings: Finding[]) {
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file) ?? "";
    if (!text.includes("/tasks/")) continue;
    const code = mask(text, false);
    const hashed = new Set([...code.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*[^;\n]*(?:createHash|\.digest\s*\()/g)].map((m) => m[1]));
    for (const m of text.matchAll(/\bname\s*:\s*`([^`]*\/tasks\/[^`]*)`/g)) {
      const tail = m[1].slice(m[1].indexOf("/tasks/"));
      const inName = [...tail.matchAll(/\$\{([^}]*)\}/g)].map((p) => p[1].trim());
      if (!inName.length) continue;
      if (inName.every((e) => /createHash|digest\s*\(/.test(e) || hashed.has(e))) continue;
      findings.push({
        id: "google-cloud/task-name-sequential",
        severity: "warning",
        file,
        line: lineAt(text, m.index!),
        message: `This task name ends with ${inName.map((e) => `\${${e}}`).join(" and ")}, not a hash. Cloud Tasks slows down on names that are sequential or share a sequential prefix, such as a timestamp or an increasing id.`,
        fix: 'Name the task with a hash of the key, such as createHash("sha256").update(key).digest("hex"), which keeps the name the same for the same key.',
        docs: `${GUIDE}#create-tasks-from-your-app`,
      });
    }
  }
}

// Worker pools don't autoscale on queue length: --instances sets a fixed count.
function workerPoolFindings(commands: Gcloud[], findings: Finding[]) {
  for (const c of commands.filter((c) => isCmd(c, "run", "worker-pools", "deploy") && !has(c, "instances"))) {
    findings.push({
      id: "google-cloud/worker-pool-instances",
      severity: "manual",
      file: c.file,
      line: c.line,
      message: `This deploys worker pool ${c.positional[3] ?? "my-app-worker"} without --instances. A worker pool runs a fixed number of instances and doesn't add any when the queue grows.`,
      fix: "Set --instances to the count your busiest hour needs, or run Google's CREMA autoscaler next to the pool, and check the count with gcloud run worker-pools describe.",
      docs: `${GUIDE}#choose-a-compute-service`,
    });
  }
}

export const googleCloud: CheckModule = {
  platform: "google-cloud",
  title: "Google Cloud",
  detect: (repo) =>
    "@google-cloud/tasks" in repo.dependencies() ||
    repo.exists("cloudbuild.yaml") ||
    repo.find(/\.(sh|ya?ml)$/).some((f) => /gcloud run (deploy|jobs)|serving\.knative\.dev|deploy-cloudrun@/.test(repo.read(f) ?? "")),
  // When every service deploy passes --command, Cloud Run never starts the Dockerfile's CMD
  suppresses: (repo) => {
    const deploys = gcloudCommands(repo).filter((c) => isCmd(c, "run", "deploy"));
    return deploys.length > 0 && deploys.every((c) => has(c, "command")) ? ["common/migrate-on-start"] : [];
  },
  run: (repo) => {
    const findings: Finding[] = [];
    const commands = gcloudCommands(repo);
    shopifyEnvFindings(repo, commands, findings);
    secretFindings(commands, findings);
    timeoutFindings(repo, commands, findings);
    startFindings(repo, commands, findings);
    iamFindings(repo, commands, findings);
    queueFindings(repo, findings);
    pubsubFindings(commands, findings);
    scalingFindings(commands, findings);
    taskRouteFindings(repo, findings);
    migrateJobFindings(repo, commands, findings);
    ownerFindings(repo, commands, findings);
    sharedAccountFindings(commands, findings);
    sqlUserFindings(commands, findings);
    memorystoreFindings(repo, commands, findings);
    poolingFindings(repo, commands, findings);
    smtpFindings(repo, findings);
    scheduleNameFindings(repo, findings);
    taskNameFindings(repo, findings);
    workerPoolFindings(commands, findings);
    return findings;
  },
};
