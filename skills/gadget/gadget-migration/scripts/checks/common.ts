// Checks that apply on every host. references/platforms/common.md explains each one.
import { DOCS, type CheckModule, type Finding, type Repo } from "./types.ts";
import { dockerCommand, lineAt, lineOf, parseDockerfile } from "./read-config.ts";

const REF = "references/platforms/common.md";

// variables that hold an origin without a trailing slash on the new host
const NO_SLASH_VARS = ["SHOPIFY_APP_URL", "APP_URL", "RENDER_EXTERNAL_URL"];
// variables that hold a bare host name, with no https://
const HOST_ONLY_VARS = ["VERCEL_URL", "VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_BRANCH_URL", "RAILWAY_PUBLIC_DOMAIN", "RAILWAY_PRIVATE_DOMAIN"];

export function appUrlFindings(repo: Repo): Finding[] {
  const findings: Finding[] = [];
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file);
    if (!text || !text.includes("process.env")) continue;

    // `${process.env.X}path` or process.env.X + "path", where the path doesn't start with a slash
    const vars = ["GADGET_APP_URL", ...NO_SLASH_VARS].join("|");
    const concat = new RegExp(`\\$\\{\\s*process\\.env\\.(${vars})\\s*\\}([A-Za-z0-9_.?#-])|process\\.env\\.(${vars})\\s*\\+\\s*["'\`]([A-Za-z0-9_.?#-])`, "g");
    for (const match of text.matchAll(concat)) {
      const name = match[1] ?? match[3];
      const isGadget = name === "GADGET_APP_URL";
      findings.push({
        id: "common/app-url-slash",
        severity: "error",
        file,
        line: lineAt(text, match.index!),
        message: isGadget
          ? "Code adds a path straight onto GADGET_APP_URL, which only works because Gadget's value ends with a slash. The value you set on the new host, such as your custom domain, usually has none."
          : `Code adds a path straight onto ${name}, which has no trailing slash.`,
        error: "https://app.example.comapi/callback",
        fix: 'Build the URL with new URL("api/callback", process.env.SHOPIFY_APP_URL), which works with or without the slash.',
        docs: `${DOCS}#environment-variables`,
      });
    }

    // a bare host name used as a URL or URL base
    const hostVars = HOST_ONLY_VARS.join("|");
    const hostUse = new RegExp(`new URL\\([^)]*process\\.env\\.(${hostVars})\\b(?![^)]*https?:)|fetch\\(\\s*process\\.env\\.(${hostVars})\\b|\\$\\{\\s*process\\.env\\.(${hostVars})\\s*\\}`, "g");
    for (const match of text.matchAll(hostUse)) {
      const name = match[1] ?? match[2] ?? match[3];
      // `https://${process.env.VERCEL_URL}` is fine
      const before = text.slice(Math.max(0, match.index! - 10), match.index!);
      if (match[3] && /https?:\/\/$/.test(before)) continue;
      findings.push({
        id: "common/host-without-scheme",
        severity: "error",
        file,
        line: lineAt(text, match.index!),
        message: `${name} holds a host name without https://, so it isn't a URL on its own.`,
        error: "TypeError: Invalid URL",
        fix: `Prefix it, as in \`https://\${process.env.${name}}\`, or use your own SHOPIFY_APP_URL.`,
        docs: `${DOCS}#environment-variables`,
      });
    }

    for (const match of text.matchAll(/process\.env\.(GADGET_[A-Z0-9_]+)/g)) {
      if (findings.some((f) => f.file === file && f.line === lineAt(text, match.index!))) continue;
      findings.push({
        id: "common/gadget-variable",
        severity: "warning",
        file,
        line: lineAt(text, match.index!),
        message: `${match[1]} was set by Gadget. Nothing sets it on the new host unless you do.`,
        fix: "Replace it with a variable you set per environment, such as SHOPIFY_APP_URL for GADGET_APP_URL and APP_ENV for GADGET_ENV. Keep the trailing slash in mind for URLs.",
        docs: `${DOCS}#environment-variables`,
      });
    }
  }
  return findings;
}

export function prismaFindings(repo: Repo): Finding[] {
  const findings: Finding[] = [];
  const schemaPath = repo.find(/(^|\/)schema\.prisma$/).find((p) => !p.includes("node_modules")) ?? null;
  if (!schemaPath) return findings;
  const schema = repo.read(schemaPath) ?? "";
  const provider = schema.match(/datasource\s+\w+\s*\{[^}]*provider\s*=\s*"([^"]+)"/)?.[1];
  const dir = schemaPath.replace(/schema\.prisma$/, "");

  if (provider === "sqlite") {
    findings.push({
      id: "common/prisma-sqlite",
      severity: "warning",
      file: schemaPath,
      line: lineOf(schema, /provider\s*=\s*"sqlite"/),
      message: "The Prisma datasource is still SQLite, as in Shopify's app template.",
      fix: 'Set provider = "postgresql" and url = env("DATABASE_URL"), then replace the template\'s migration (see common/sqlite-migration).',
      docs: `${DOCS}#install-and-authenticate-merchants`,
    });
  }
  if (provider !== "postgresql") return findings;

  const lock = repo.read(`${dir}migrations/migration_lock.toml`);
  if (lock && /provider\s*=\s*"sqlite"/.test(lock)) {
    findings.push({
      id: "common/sqlite-migration-lock",
      severity: "error",
      file: `${dir}migrations/migration_lock.toml`,
      line: lineOf(lock, "sqlite"),
      message: "migration_lock.toml still says sqlite while the schema says postgresql.",
      error: "Error: P3019",
      fix: "Delete prisma/migrations, then run prisma migrate dev --name init against a local Postgres database and commit the new folder.",
      docs: `${DOCS}#install-and-authenticate-merchants`,
    });
  }
  for (const file of repo.find(new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}migrations/[^/]+/migration\\.sql$`))) {
    const sql = repo.read(file) ?? "";
    const match = sql.match(/\bDATETIME\b|\bAUTOINCREMENT\b|PRAGMA /);
    if (!match) continue;
    findings.push({
      id: "common/sqlite-migration",
      severity: "error",
      file,
      line: lineOf(sql, match[0]),
      message: "This migration is written for SQLite, like the one in Shopify's app template, and fails on Postgres.",
      error: 'type "datetime" does not exist',
      fix: "Delete prisma/migrations, then run prisma migrate dev --name init against a local Postgres database and commit the new folder before the first deploy.",
      docs: `${DOCS}#install-and-authenticate-merchants`,
    });
  }
  return findings;
}

// Whether the Dockerfile generates the Prisma client after the schema is copied in.
export function dockerfileGeneratesPrisma(repo: Repo): boolean {
  const text = repo.read("Dockerfile");
  if (!text) return false;
  const steps = parseDockerfile(text);
  // the COPY that brings in the whole project, and with it prisma/schema.prisma
  const copyAll = steps.findIndex((s) => s.instruction === "COPY" && /^(--\S+\s+)*\.\s+\S+$/.test(s.args));
  return steps.some((step, index) => {
    if (index < copyAll || step.instruction !== "RUN") return false;
    if (/prisma\s+generate/.test(step.args)) return true;
    // npm run build, where the build script runs prisma generate
    return /prisma\s+generate/.test(expandScripts(repo, step.args));
  });
}

// The command the Dockerfile starts, from its last CMD, and the line it's on.
export function dockerfileCmd(repo: Repo): { command: string; line: number } | null {
  const text = repo.read("Dockerfile");
  if (!text) return null;
  const cmd = parseDockerfile(text).filter((s) => s.instruction === "CMD").pop();
  return cmd ? { command: dockerCommand(cmd.args), line: cmd.line } : null;
}

// Findings for a platform that starts the image with its own command instead of the Dockerfile's CMD.
export function startOverrideFindings(repo: Repo, platform: string, file: string, line: number | undefined, command: string, docs: string): Finding[] {
  const deps = repo.dependencies();
  if (!deps["@prisma/client"] && !deps.prisma) return [];
  if (!repo.exists("Dockerfile")) return [];
  if (/prisma\s+generate/.test(expandScripts(repo, command))) return [];
  if (dockerfileGeneratesPrisma(repo)) return [];
  return [
    {
      id: `${platform}/prisma-generate`,
      severity: "error",
      file,
      line,
      message: `This starts the image with "${command}" instead of the template's docker-start script, and nothing in the Dockerfile runs prisma generate after the schema is copied in.`,
      error: "@prisma/client did not initialize yet",
      fix: "Add RUN npx prisma generate to the Dockerfile after COPY . .",
      docs,
    },
  ];
}

// A command with each "npm run x" replaced by the x script from package.json, a few levels deep.
export function expandScripts(repo: Repo, command: string): string {
  const scripts = repo.scripts();
  let out = command;
  for (let depth = 0; depth < 5; depth++) {
    const next = out.replace(/\b(?:npm|pnpm|yarn) run ([\w:.-]+)/g, (whole, name) => (name in scripts ? `(${scripts[name]})` : whole));
    if (next === out) break;
    out = next;
  }
  return out;
}

function dockerfileFindings(repo: Repo): Finding[] {
  const cmd = dockerfileCmd(repo);
  if (!cmd) return [];
  const runs = expandScripts(repo, cmd.command);
  if (!/migrate deploy|db push/.test(runs)) return [];
  return [
    {
      id: "common/migrate-on-start",
      severity: "warning",
      file: "Dockerfile",
      line: cmd.line,
      message: `The image starts with "${cmd.command}", which runs "${runs}". Every instance runs your migrations when it starts, and a webhook that wakes a new instance waits for them.`,
      fix: "Run migrations once per deploy in your host's release or pre-deploy step, start the server with npm run start, and add RUN npx prisma generate after COPY . . in the Dockerfile.",
      docs: `${DOCS}#set-up-development-and-deploys`,
    },
  ];
}

function workerFindings(repo: Repo): Finding[] {
  const findings: Finding[] = [];
  const deps = repo.dependencies();
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file);
    if (!text || !/new Worker\s*\(/.test(text) || !/from\s+["']bullmq["']/.test(text)) continue;
    if (/process\.(on|once)\(\s*["']SIGTERM["']/.test(text)) continue;
    findings.push({
      id: "common/worker-sigterm",
      severity: "error",
      file,
      line: lineOf(text, /new Worker\s*\(/),
      message: "This BullMQ worker doesn't close on SIGTERM. Every deploy stops it in the middle of its jobs, and BullMQ reruns them after its stall check, or fails them once maxStalledCount is used up.",
      error: "job stalled more than allowable limit",
      fix: 'Add process.on("SIGTERM", async () => { await worker.close(); process.exit(0); }), and start the worker with node directly so the signal reaches it.',
      docs: `${DOCS}#make-jobs-safe-to-retry`,
    });
  }
  const bullmq = deps.bullmq?.match(/(\d+)/)?.[1];
  if (bullmq && Number(bullmq) >= 6 && !deps.ioredis && repo.sourceFiles().some((f) => /from\s+["']ioredis["']/.test(repo.read(f) ?? ""))) {
    findings.push({
      id: "common/bullmq-ioredis",
      severity: "error",
      file: "package.json",
      message: "Code imports ioredis, and BullMQ 6 no longer installs it for you.",
      error: "Cannot find package 'ioredis'",
      fix: "npm install ioredis",
    });
  }
  if (deps.bullmq) {
    findings.push({
      id: "common/redis-eviction",
      severity: "manual",
      message: "A Redis that evicts keys when its memory is full drops queued BullMQ jobs without an error.",
      error: 'IMPORTANT! Eviction policy is allkeys-lru. It should be "noeviction"',
      fix: 'Run redis-cli -u "$REDIS_URL" CONFIG GET maxmemory-policy (or check the provider\'s settings where CONFIG is disabled) and set it to noeviction.',
    });
  }
  for (const file of repo.sourceFiles().filter((f) => /(^|\/)(scripts|cron|jobs)\//.test(f))) {
    const text = repo.read(file) ?? "";
    if (/new Queue\s*\(/.test(text) && /\.add\s*\(/.test(text) && !/\.close\s*\(/.test(text) && !/new Worker\s*\(/.test(text)) {
      findings.push({
        id: "common/cron-script-exit",
        severity: "warning",
        file,
        line: lineOf(text, /new Queue\s*\(/),
        message: "This script adds a job and never closes its queue, so its open Redis connection keeps the process running. Railway skips every later run of a cron service while one is still going, and Render delays them.",
        fix: "await queue.close() and disconnect the Redis connection at the end of the script.",
        docs: `${DOCS}#replace-scheduled-actions`,
      });
    }
  }
  return findings;
}

function databaseFindings(repo: Repo): Finding[] {
  const findings: Finding[] = [];
  const sqlFiles = repo.find(/\.sql$/);
  const policy = sqlFiles.find((f) => /create\s+policy|enable\s+row\s+level\s+security/i.test(repo.read(f) ?? ""));
  if (policy) {
    findings.push({
      id: "common/rls-role",
      severity: "manual",
      file: policy,
      message: "The app uses row-level security, which Postgres skips for superusers, roles with BYPASSRLS, and the table's owner. Most hosts' default database user is one of those.",
      fix: 'Run psql "<the URL your app uses>" -f scripts/db-check.sql from this skill, as the role the app connects with, and fix every row marked problem.',
      docs: `${DOCS}#rewrite-permissions-and-shop-tenancy`,
    });
  }
  const load = sqlFiles.find((f) => /create\s+temp(orary)?\s+table/i.test(repo.read(f) ?? "") && /\\copy/i.test(repo.read(f) ?? ""));
  if (load) {
    findings.push({
      id: "common/load-direct-connection",
      severity: "manual",
      file: load,
      message: "This load script keeps a temporary table between statements, which a pooler in transaction mode can hand to another connection.",
      error: 'relation "widget_import" does not exist',
      fix: "Run it over the database's direct URL, not the pooled one. See the pooler table in common.md for each provider's direct URL.",
      docs: `${DOCS}#load-your-records`,
    });
  }
  return findings;
}

export const common: CheckModule = {
  platform: "common",
  title: "Every host",
  detect: () => true,
  run: (repo) => [...appUrlFindings(repo), ...prismaFindings(repo), ...dockerfileFindings(repo), ...workerFindings(repo), ...databaseFindings(repo)],
};
