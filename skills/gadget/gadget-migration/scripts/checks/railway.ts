// Checks for apps moving to Railway. references/platforms/railway.md explains each one.
// .railway/railway.ts is TypeScript, so these checks read it as text: each service("name", { ... })
// call's object, and the variable strings anywhere in the file.
import { DOCS, type CheckModule, type Finding, type Repo } from "./types.ts";
import { lineAt, lineOf, parseJsonc, parseToml } from "./read-config.ts";
import { dockerfilePath, expandScripts, startOverrideFindings } from "./common.ts";

const GUIDE = `${DOCS}/railway`;
const IAC = ".railway/railway.ts";
const MIGRATES = /migrate\s+deploy|db\s+push|migrate:deploy/;
const MIGRATE_LOCK_ERROR = "Error: P1002 ... Timed out trying to acquire a postgres advisory lock (SELECT pg_advisory_lock(72707369)). Timeout: 10000ms.";
// the AWS SDK's limit for a SigV4 presigned URL, whatever the bucket allows
const PRESIGN_MAX_SECONDS = 7 * 24 * 60 * 60;

// The index just past the bracket that closes the one at `open`, skipping strings and comments.
export function closeOf(text: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) return -1;
      i++;
    } else if (pairs[c]) {
      stack.push(pairs[c]);
    } else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

interface ServiceCall {
  name: string;
  // the object literal passed as the second argument, and where it starts in the file
  body: string;
  start: number;
  line: number;
}

function serviceCalls(text: string): ServiceCall[] {
  const out: ServiceCall[] = [];
  for (const match of text.matchAll(/\bservice\(\s*(["'`])([^"'`]+)\1\s*,\s*\{/g)) {
    const open = match.index! + match[0].length - 1;
    const close = closeOf(text, open);
    if (close < 0) continue;
    out.push({ name: match[2], body: text.slice(open, close), start: open, line: lineAt(text, match.index!) });
  }
  return out;
}

// The string value of the first `key: "..."` in an object's text.
function stringValue(body: string, key: RegExp): { value: string; index: number } | null {
  const match = body.match(new RegExp(`\\b(?:${key.source})\\s*:\\s*(["'\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`));
  return match ? { value: match[2], index: match.index! } : null;
}

// The text of `const name = { ... }`, so a service that passes env: name can be read through it.
function objectNamed(text: string, identifier: string): string {
  const match = text.match(new RegExp(`\\b(?:const|let|var)\\s+${identifier}\\b[^=]*=\\s*\\{`));
  if (!match) return "";
  const open = match.index! + match[0].length - 1;
  const close = closeOf(text, open);
  return close < 0 ? "" : text.slice(open, close);
}

// The value of a number expression made of digits, *, +, and parentheses, such as 90 * 24 * 60 * 60.
export function arithmetic(expression: string): number | null {
  const tokens = expression.replace(/_/g, "").match(/\d+|[*+()]|\S/g) ?? [];
  let i = 0;
  const factor = (): number => {
    const token = tokens[i++];
    if (token === "(") {
      const value = sum();
      if (tokens[i++] !== ")") throw new Error("expected )");
      return value;
    }
    if (!/^\d+$/.test(token ?? "")) throw new Error("expected a number");
    return Number(token);
  };
  const product = (): number => {
    let value = factor();
    while (tokens[i] === "*") (i++, (value *= factor()));
    return value;
  };
  const sum = (): number => {
    let value = product();
    while (tokens[i] === "+") (i++, (value += product()));
    return value;
  };
  try {
    const value = sum();
    return i === tokens.length ? value : null;
  } catch {
    return null;
  }
}

// The smallest number of minutes between two runs of a five-field cron schedule, or null if it can't tell.
export function minutesBetweenRuns(schedule: string): number | null {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const expand = (field: string, max: number): number[] | null => {
    const values = new Set<number>();
    for (const part of field.split(",")) {
      const match = part.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
      if (!match) return null;
      const from = match[1] === "*" ? 0 : Number(match[2]);
      const to = match[1] === "*" ? max : match[3] !== undefined ? Number(match[3]) : match[4] ? max : from;
      const step = match[4] ? Number(match[4]) : 1;
      if (step < 1 || from > to || to > max) return null;
      for (let v = from; v <= to; v += step) values.add(v);
    }
    return [...values].sort((a, b) => a - b);
  };
  const minutes = expand(fields[0], 59);
  const hours = expand(fields[1], 23);
  if (!minutes || !hours) return null;
  const times = hours.flatMap((h) => minutes.map((m) => h * 60 + m));
  let gap = Infinity;
  for (let i = 1; i < times.length; i++) gap = Math.min(gap, times[i] - times[i - 1]);
  // the last run of one day and the first of the next, when every day runs
  if (fields.slice(2).every((f) => f === "*")) gap = Math.min(gap, 1440 - times[times.length - 1] + times[0]);
  return gap === Infinity ? 1440 : gap;
}

// The Dockerfile a service builds: its dockerfilePath or RAILWAY_DOCKERFILE_PATH, then railway.json's or
// railway.toml's build.dockerfilePath, then Dockerfile. Null when a builder other than Dockerfile is set,
// such as Railpack, which ignores the Dockerfile.
function dockerfileOf(repo: Repo, body: string, envText: string): string | null {
  let build: any = {};
  for (const file of ["railway.json", "railway.toml"]) {
    const text = repo.read(file);
    if (text === null) continue;
    try {
      build = (file.endsWith(".json") ? parseJsonc(text) : parseToml(text))?.build ?? {};
    } catch {}
    break;
  }
  const builder = stringValue(body, /builder/)?.value ?? (typeof build.builder === "string" ? build.builder : undefined);
  if (builder && !/docker/i.test(builder)) return null;
  return dockerfilePath(stringValue(body, /dockerfilePath/)?.value ?? stringValue(envText, /RAILWAY_DOCKERFILE_PATH/)?.value ?? build.dockerfilePath);
}

function iacFindings(repo: Repo, text: string): Finding[] {
  const findings: Finding[] = [];
  const push = (f: Omit<Finding, "file">) => findings.push({ file: IAC, ...f });
  const calls = serviceCalls(text);
  if (calls.length === 0 && !/\b(postgres|redis)\(/.test(text)) {
    return [
      {
        id: "railway/config-unreadable",
        severity: "manual",
        file: IAC,
        message: 'No service("name", { ... }) calls were found in .railway/railway.ts, so its Railway checks didn\'t run.',
        fix: "Run railway config plan --verbose and check the rows of the Checks to run table in references/platforms/railway.md by hand.",
        docs: `${GUIDE}#describe-your-project-in-one-file`,
      },
    ];
  }

  let overrideChecked = false;
  for (const call of calls) {
    const at = (index: number) => lineAt(text, call.start + index);
    const cron = stringValue(call.body, /cronSchedule/);
    const start = stringValue(call.body, /start|startCommand|command/);
    const envName = call.body.match(/\b(?:env|variables)\s*:\s*([A-Za-z_$][\w$]*)\b/)?.[1] ?? call.body.match(/\.\.\.([A-Za-z_$][\w$]*)/)?.[1];
    const envText = call.body + (envName ? objectNamed(text, envName) : "");
    const hasDomains = /\bdomains\s*:\s*(?!\[\s*\])/.test(call.body);

    if (cron) {
      const gap = minutesBetweenRuns(cron.value);
      if (gap !== null && gap < 5) {
        push({
          id: "railway/cron-interval",
          severity: "error",
          line: at(cron.index),
          message: `The schedule "${cron.value}" for ${call.name} has runs ${gap} minute${gap === 1 ? "" : "s"} apart, and Railway requires at least 5 minutes between runs.`,
          fix: "Use a schedule whose runs are 5 or more minutes apart, counting across the hour, or schedule the job in your queue instead.",
          docs: `${GUIDE}#replace-scheduled-actions`,
        });
      }
      push({
        id: "railway/cron-before-cutover",
        severity: "manual",
        line: call.line,
        message: `Cron service ${call.name} runs on its schedule ("${cron.value}") as soon as railway config apply deploys it, while Gadget's scheduled action still runs.`,
        fix: "Add the cron service to the file and apply it in the cutover's Move scheduled work step, in the same hour you turn off Gadget's scheduler trigger.",
        docs: `${GUIDE}#cut-over-to-the-new-platform`,
      });
      continue;
    }

    if (!/\bdrainingSeconds\s*:/.test(call.body) && !/RAILWAY_DEPLOYMENT_DRAINING_SECONDS/.test(envText)) {
      push({
        id: "railway/draining",
        severity: "warning",
        line: call.line,
        message: hasDomains
          ? `Web service ${call.name} has no drainingSeconds, so Railway sends SIGKILL right after SIGTERM and cuts off the webhook requests the old deployment is still answering.`
          : `${call.name} has no drainingSeconds, so Railway sends SIGKILL right after SIGTERM on every deploy and kills the jobs it's running.`,
        error: hasDomains ? undefined : "job stalled more than allowable limit",
        fix: hasDomains ? "Add deploy: { drainingSeconds: 30 }." : "Add deploy: { drainingSeconds: <seconds> } above your longest job, such as 900 for a 12-minute job.",
        docs: hasDomains ? `${GUIDE}#receive-webhooks` : `${GUIDE}#check-your-host-s-time-limits`,
      });
    }
    if (start && /^\s*pnpm\b/.test(start.value)) {
      push({
        id: "railway/pnpm-start",
        severity: "error",
        line: at(start.index),
        message: `${call.name} starts through pnpm, which didn't pass SIGTERM on to Node in a test, so it never drains and is killed when its draining time ends.`,
        fix: "Start it with node and a compiled file, such as start: \"node build/worker.js\", or with npm run, which passed the signal on.",
        docs: `${GUIDE}#check-your-host-s-time-limits`,
      });
    }
    if (start && MIGRATES.test(expandScripts(repo, start.value))) {
      push({
        id: "railway/migrate-on-start",
        severity: "warning",
        line: at(start.index),
        message: `${call.name} runs migrations when it starts, so every replica runs them.`,
        fix: 'Start without migrations, such as start: "npm run start", and add preDeploy: "npx prisma migrate deploy" to the web service.',
        docs: `${GUIDE}#run-migrations-once-per-deploy`,
      });
    }
    const dockerfile = dockerfileOf(repo, call.body, envText);
    if (start && dockerfile && !overrideChecked) {
      overrideChecked = true;
      findings.push(...startOverrideFindings(repo, "railway", IAC, at(start.index), start.value, `${GUIDE}#run-migrations-once-per-deploy`, dockerfile));
    }
    const sleeps = call.body.match(/\bsleepApplication\s*:\s*true\b/);
    if (sleeps) {
      push({
        id: "railway/serverless",
        severity: hasDomains ? "error" : "warning",
        line: at(sleeps.index!),
        message: `${call.name} has Serverless on, so it sleeps after 5 to 10 minutes without outbound traffic, and the request that wakes it can fail.`,
        error: "502 Bad Gateway",
        fix: "Remove sleepApplication: true from the service, and check that Serverless is off in its settings.",
        docs: `${GUIDE}#receive-webhooks`,
      });
    }
    if (hasDomains && !/\bhealthcheck(Path)?\s*:/.test(call.body)) {
      push({
        id: "railway/health-check",
        severity: "warning",
        line: call.line,
        message: `Web service ${call.name} has no health check, so Railway sends it traffic as soon as its container starts, before the server listens.`,
        fix: 'Add a route that queries the database and set healthcheck: "/healthz".',
        docs: `${GUIDE}#receive-webhooks`,
      });
    }
  }

  // variables
  const usesRls = repo.find(/\.sql$/).some((f) => /create\s+policy/i.test(repo.read(f) ?? ""));
  const templateUrl = (variable: string) =>
    new RegExp(`\\b${variable}\\s*:\\s*(?:[\\w$]+\\.env\\.DATABASE_(?:PUBLIC_)?URL\\b|ref\\(\\s*[\\w$]+\\s*,\\s*["'\`]DATABASE_(?:PUBLIC_)?URL["'\`]\\s*\\)|["'\`]\\$\\{\\{\\s*[\\w-]+\\.DATABASE_(?:PUBLIC_)?URL\\s*\\}\\}["'\`])`);
  const superuser = usesRls ? text.match(templateUrl("DATABASE_URL")) : null;
  if (superuser) {
    push({
      id: "railway/superuser-url",
      severity: "error",
      line: lineAt(text, superuser.index!),
      message: "The app connects with the Postgres template's DATABASE_URL, whose user, postgres, is a superuser, so Postgres skips your row-level security policies and a query with no store set returns every store's rows.",
      fix: "Create a role with nosuperuser nobypassrls for the app, build DATABASE_URL from it, and keep the template's URL for migrations only.",
      docs: `${GUIDE}#rewrite-permissions-and-shop-tenancy`,
    });
  }
  const schemaPath = repo.find(/(^|\/)schema\.prisma$/)[0];
  const directVar = schemaPath ? repo.read(schemaPath)?.match(/directUrl\s*=\s*env\(\s*"([^"]+)"\s*\)/)?.[1] : undefined;
  const direct = directVar ? text.match(templateUrl(directVar)) : null;
  if (direct) {
    push({
      id: "railway/direct-url-pooler",
      severity: "manual",
      line: lineAt(text, direct.index!),
      message: `${directVar} is the Postgres service's DATABASE_URL. Once you add PgBouncer, Railway points that variable at PgBouncer, and Prisma Migrate's lock stays on a pooled connection after each deploy, so the next one fails.`,
      error: MIGRATE_LOCK_ERROR,
      fix: `If the database has Connection Pooling on, set ${directVar} to ref(db, "DATABASE_UNPOOLED_URL") or \${{postgres.DATABASE_UNPOOLED_URL}}.`,
      docs: `${GUIDE}#add-a-connection-pool`,
    });
  }
  const privateUrl = text.match(/(?:RAILWAY_PRIVATE_DOMAIN|PGHOST)\s*\}\}:(?:5432|\$\{\{\s*[\w-]+\.PGPORT)/);
  if (privateUrl) {
    push({
      id: "railway/private-domain-url",
      severity: "manual",
      line: lineAt(text, privateUrl.index!),
      message: "This URL is built from the Postgres service's private domain, which reaches one Postgres server directly. Railway updates references to DATABASE_URL when you add PgBouncer or high availability, but not a URL built this way.",
      fix: "Check the database's Config page. With Connection Pooling or high availability on, use the host and port from its DATABASE_URL in this URL.",
      docs: `${GUIDE}#rewrite-permissions-and-shop-tenancy`,
    });
  }
  const names = new Set([...text.matchAll(/\b(?:service|postgres|redis|mysql|mongo|bucket|fn|volume|database)\(\s*(["'`])([^"'`]+)\1/g)].map((m) => m[2]));
  const literalNames = ![...text.matchAll(/\b(?:service|postgres|redis|mysql|mongo|bucket|fn|database)\(\s*([^\s"'`)])/g)].length;
  for (const match of literalNames ? text.matchAll(/\$\{\{\s*([\w-]+)\.([A-Za-z0-9_]+)\s*\}\}/g) : []) {
    if (match[1] === "shared" || names.has(match[1])) continue;
    const near = [...names].find((n) => n.toLowerCase() === match[1].toLowerCase());
    push({
      id: "railway/unknown-reference",
      severity: "warning",
      line: lineAt(text, match.index!),
      message: near
        ? `\${{${match[1]}.${match[2]}}} names a service the file doesn't define: the file calls it ${near}, and Railway resolves references by the exact service name.`
        : `\${{${match[1]}.${match[2]}}} names a service the file doesn't define, such as one added from the dashboard, and railway config apply deletes every resource the file leaves out.`,
      fix: near ? `Write \${{${near}.${match[2]}}}, or use the resource's .env accessor, such as db.env.${match[2]}.` : `Define ${match[1]} in the file, such as with redis("${match[1].toLowerCase()}") or postgres(...), and reference it through its .env accessor.`,
      docs: `${GUIDE}#move-environment-variables-email-and-domains`,
    });
  }
  for (const match of text.matchAll(/\$\{\{\s*(?:[\w-]+\.)?RAILWAY_PUBLIC_DOMAIN\s*\}\}/g)) {
    const lineStart = text.lastIndexOf("\n", match.index!) + 1;
    const before = text.slice(lineStart, match.index!);
    const key = before.match(/["']?([A-Za-z0-9_]+)["']?\s*:\s*["'`][^"'`]*$/)?.[1];
    if (!key || !/URL|ORIGIN/.test(key) || /https?:\/\/$/.test(before)) continue;
    push({
      id: "railway/public-domain-scheme",
      severity: "error",
      line: lineAt(text, match.index!),
      message: `${key} is set to RAILWAY_PUBLIC_DOMAIN, which holds a bare host name such as example.up.railway.app, with no https://.`,
      error: "TypeError: Invalid URL",
      fix: `Set it to "https://\${{RAILWAY_PUBLIC_DOMAIN}}", or to your custom domain, such as https://app.example.com.`,
      docs: `${GUIDE}#environment-variables`,
    });
  }

  push({
    id: "railway/config-apply",
    severity: "manual",
    message: "railway config apply deletes every resource the file leaves out, such as a PgBouncer service, a point-in-time recovery bucket, or a Redis you added from the dashboard.",
    fix: "Run railway config plan --verbose before every apply and read each line it marks as destructive.",
    docs: `${GUIDE}#describe-your-project-in-one-file`,
  });
  return findings;
}

function queueFindings(repo: Repo, iac: string | null): Finding[] {
  const findings: Finding[] = [];
  const deps = repo.dependencies();
  // the redis() helper deploys railwayapp/redis:8.2, which writes an append-only file already
  if (deps.bullmq && !(iac && /\bredis\(\s*["'`]/.test(iac))) {
    findings.push({
      id: "railway/redis-persistence",
      severity: "manual",
      message: "Railway's Redis template, which the dashboard adds, saves a snapshot at most once a minute, and its default draining time is 0 seconds, so a redeploy or a host move loses up to the last minute of queued jobs.",
      fix: 'Run railway connect redis, then CONFIG GET appendonly. If it prints "no", run CONFIG SET appendonly yes, wait for INFO persistence to show aof_rewrite_in_progress:0 and aof_last_bgrewrite_status:ok, and only then add --appendonly yes to the start command.',
      docs: `${GUIDE}#keep-queued-jobs-through-a-redis-restart`,
    });
  }

  // ioredis before 5.8.2 looks up IPv4 addresses only, and older Railway environments resolve private names to IPv6 only
  let ioredis: string | undefined;
  try {
    ioredis = JSON.parse(repo.read("package-lock.json") ?? "{}").packages?.["node_modules/ioredis"]?.version;
  } catch {}
  const [major, minor, patch] = (ioredis ?? "").split(".").map(Number);
  if (ioredis && (major < 5 || (major === 5 && (minor < 8 || (minor === 8 && patch < 2))))) {
    for (const file of repo.sourceFiles()) {
      const text = repo.read(file);
      if (!text) continue;
      for (const match of text.matchAll(/new\s+(?:IORedis|Redis)\s*\(|\bconnection\s*:\s*\{/g)) {
        const open = match.index! + match[0].length - 1;
        const close = closeOf(text, open);
        if (close < 0 || /family/.test(text.slice(open, close))) continue;
        findings.push({
          id: "railway/ioredis-family",
          severity: "warning",
          file,
          line: lineAt(text, match.index!),
          message: `This Redis connection doesn't set family, and ioredis ${ioredis} looks up IPv4 addresses only. Railway environments created before 16 October 2025 resolve private names such as redis.railway.internal to IPv6 only.`,
          fix: "Pass family: 0, or add ?family=0 to the URL, or upgrade to ioredis 5.8.2 or later, whose default is 0.",
          docs: `${GUIDE}#replace-background-and-scheduled-actions`,
        });
      }
    }
  }
  return findings;
}

function sourceFindings(repo: Repo): Finding[] {
  const findings: Finding[] = [];
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file);
    if (!text) continue;
    const bucketName = text.match(/process\.env\.RAILWAY_BUCKET_NAME\b/);
    if (bucketName) {
      findings.push({
        id: "railway/bucket-name",
        severity: "error",
        file,
        line: lineAt(text, bucketName.index!),
        message: "RAILWAY_BUCKET_NAME is the bucket's display name, and Railway's docs say it isn't the name the S3 API takes.",
        fix: "Use the bucket's BUCKET variable as the Bucket in every S3 call.",
        docs: `${GUIDE}#search-files-and-other-services`,
      });
    }
    if (!/@aws-sdk\/s3-request-presigner/.test(text)) continue;
    for (const match of text.matchAll(/\bexpiresIn\s*:\s*([\d_\s*+()]+?)\s*[,}\n]/g)) {
      const seconds = arithmetic(match[1]);
      if (seconds === null || seconds <= PRESIGN_MAX_SECONDS) continue;
      findings.push({
        id: "railway/presign-expiry",
        severity: "error",
        file,
        line: lineAt(text, match.index!),
        message: `expiresIn is ${seconds} seconds. Railway buckets accept presigned URLs of up to 90 days, but the AWS SDK refuses to sign one for longer than 7 days (604800 seconds).`,
        error: "Signature version 4 presigned URLs must have an expiration date less than one week in the future",
        fix: "Sign for 7 days or less. For a URL that must keep working, store a route in your app that signs a fresh URL and redirects to it.",
        docs: `${GUIDE}#search-files-and-other-services`,
      });
    }
  }
  if (repo.dependencies().nodemailer) {
    findings.push({
      id: "railway/smtp",
      severity: "manual",
      file: "package.json",
      message: "The app depends on nodemailer, and every send fails if Railway blocks outbound SMTP for the workspace. Railway's outbound networking page (https://docs.railway.com/networking/outbound-networking#email-delivery) says which plans allow it.",
      fix: "Send through your email provider's HTTP API, or confirm your workspace's plan allows outbound SMTP and redeploy the service after any plan change.",
      docs: `${GUIDE}#email-and-custom-domains`,
    });
  }
  return findings;
}

function configAsCodeFindings(repo: Repo): Finding[] {
  const findings: Finding[] = [];
  for (const file of ["railway.json", "railway.toml"]) {
    const text = repo.read(file);
    if (text === null) continue;
    let keys: string[] = [];
    try {
      const doc = file.endsWith(".json") ? parseJsonc(text) : parseToml(text);
      keys = Object.keys(doc?.deploy ?? {});
    } catch {}
    findings.push({
      id: "railway/config-as-code",
      severity: "warning",
      file,
      line: keys.length ? lineOf(text, /deploy/) : undefined,
      message: `Railway has deprecated ${file}: new services can't use it, and existing services stop reading it on 1 December 2026${keys.length ? `, which drops its deploy settings (${keys.join(", ")})` : ""}.`,
      fix: "Move the settings to .railway/railway.ts. On a linked project, railway config migrate --variables=unmanaged --show prints the translated file.",
      docs: `${GUIDE}#describe-your-project-in-one-file`,
    });
  }
  return findings;
}

export const railway: CheckModule = {
  platform: "railway",
  title: "Railway",
  detect: (repo) => repo.exists(IAC) || repo.exists("railway.json") || repo.exists("railway.toml") || "railway" in repo.dependencies(),
  run: (repo) => {
    const iac = repo.read(IAC);
    return [...(iac === null ? [] : iacFindings(repo, iac)), ...configAsCodeFindings(repo), ...queueFindings(repo, iac), ...sourceFindings(repo)];
  },
  // the Dockerfile's CMD never runs when every service in the project file has its own start
  // command, and railway/migrate-on-start checks those commands instead
  suppresses: (repo) => {
    const iac = repo.read(IAC);
    if (iac === null) return [];
    const services = serviceCalls(iac);
    return services.length > 0 && services.every((s) => stringValue(s.body, /start/) !== null) ? ["common/migrate-on-start"] : [];
  },
};
