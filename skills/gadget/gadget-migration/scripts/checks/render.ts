// Checks for apps moving to Render. references/platforms/render.md explains each one.
import { DOCS, type CheckModule, type Finding, type Repo } from "./types.ts";
import { keyLine, lineAt, lineOf, parseYaml } from "./read-config.ts";
import { dockerfileCmd, dockerfilePath, expandScripts, startOverrideFindings } from "./common.ts";

const GUIDE = `${DOCS}/render`;
const FILE = "render.yaml";
const QUEUE_LIBRARIES = ["bullmq", "bull", "bee-queue"];
const MIGRATES = /migrate\s+deploy|db\s+push|migrate:deploy/;
// Prisma Migrate's session-level advisory lock, which a transaction-mode pool keeps after Prisma disconnects
const MIGRATE_LOCK_ERROR = "Error: P1002 ... Timed out trying to acquire a postgres advisory lock (SELECT pg_advisory_lock(72707369)). Timeout: 10000ms.";

interface Resource {
  kind: "service" | "database" | "group";
  node: any;
  // the environment's name, or null for services outside projects
  env: string | null;
  line: number | undefined;
}

// Every service, database, and environment group in the Blueprint, with the environment it belongs to.
function resources(doc: any): Resource[] {
  const out: Resource[] = [];
  const add = (scope: any, env: string | null) => {
    if (!scope || typeof scope !== "object") return;
    for (const [key, kind] of [["services", "service"], ["databases", "database"], ["envVarGroups", "group"]] as const) {
      const list = scope[key];
      if (!Array.isArray(list)) continue;
      list.forEach((node, index) => {
        if (node && typeof node === "object") out.push({ kind, node, env, line: keyLine(list, index) });
      });
    }
  };
  add(doc, null);
  add(doc.ungrouped, null);
  for (const project of Array.isArray(doc.projects) ? doc.projects : []) {
    for (const environment of Array.isArray(project?.environments) ? project.environments : []) add(environment, String(environment?.name ?? ""));
  }
  return out;
}

const isProduction = (r: Resource) => !/stag|dev|preview|test|qa|sandbox/i.test(`${r.env ?? ""} ${r.node.name ?? ""}`);
const name = (r: Resource) => String(r.node.name ?? r.node.type);
const lineOfKey = (r: Resource, key: string) => keyLine(r.node, key) ?? r.line;

// The Dockerfile a Docker service builds: dockerfilePath, inside rootDir when the service sets one.
function dockerfileOf(repo: Repo, r: Resource): string {
  const path = dockerfilePath(r.node.dockerfilePath);
  const inRoot = typeof r.node.rootDir === "string" && r.node.rootDir.trim() ? dockerfilePath(r.node.dockerfilePath, dockerfilePath(r.node.rootDir)) : null;
  return inRoot && !repo.exists(path) && repo.exists(inRoot) ? inRoot : path;
}

// The command a service starts with: its own, or the Dockerfile's CMD for a Docker service without one.
function startCommand(repo: Repo, r: Resource): { command: string; key?: string } | null {
  if (typeof r.node.dockerCommand === "string") return { command: r.node.dockerCommand, key: "dockerCommand" };
  if (typeof r.node.startCommand === "string") return { command: r.node.startCommand, key: "startCommand" };
  if (r.node.runtime === "docker") {
    const cmd = dockerfileCmd(repo, dockerfileOf(repo, r));
    if (cmd) return { command: cmd.command };
  }
  return null;
}

function prismaUrls(repo: Repo): { url?: string; directUrl?: string } {
  const path = repo.find(/(^|\/)schema\.prisma$/)[0];
  const schema = path ? (repo.read(path) ?? "") : "";
  const datasource = schema.match(/datasource\s+\w+\s*\{([^}]*)\}/)?.[1] ?? "";
  return {
    url: datasource.match(/(?:^|\n)\s*url\s*=\s*env\(\s*"([^"]+)"\s*\)/)?.[1],
    directUrl: datasource.match(/directUrl\s*=\s*env\(\s*"([^"]+)"\s*\)/)?.[1],
  };
}

function blueprintFindings(repo: Repo, doc: any): Finding[] {
  const findings: Finding[] = [];
  const all = resources(doc);
  const services = all.filter((r) => r.kind === "service");
  const databases = all.filter((r) => r.kind === "database");
  const deps = repo.dependencies();
  const push = (f: Omit<Finding, "file">) => findings.push({ file: FILE, ...f });

  // Key Value as a job queue
  const queueLibrary = QUEUE_LIBRARIES.find((l) => l in deps);
  const keyValues = services.filter((r) => r.node.type === "keyvalue" || r.node.type === "redis");
  const queues = keyValues.length === 1 ? keyValues : keyValues.filter((r) => !/cache/i.test(name(r)));
  for (const kv of queueLibrary ? queues : []) {
    const policy = kv.node.maxmemoryPolicy;
    if (policy !== "noeviction") {
      push({
        id: "render/keyvalue-eviction",
        severity: "error",
        line: lineOfKey(kv, "maxmemoryPolicy"),
        message: policy
          ? `Key Value ${name(kv)} uses maxmemoryPolicy ${policy}, so it deletes queued ${queueLibrary} jobs when its memory is full, and every add still succeeds.`
          : `Key Value ${name(kv)} has no maxmemoryPolicy, so it gets Render's default, allkeys-lru, and deletes queued ${queueLibrary} jobs when its memory is full. Every add still succeeds.`,
        error: queueLibrary === "bullmq" ? 'IMPORTANT! Eviction policy is allkeys-lru. It should be "noeviction"' : undefined,
        fix: "Add maxmemoryPolicy: noeviction to the Key Value instance and sync the Blueprint.",
        docs: `${GUIDE}#create-a-key-value-instance-for-your-queue`,
      });
    }
    const memoryOnly = kv.node.plan === "free" || kv.node.persistenceMode === "off";
    if (memoryOnly || kv.node.persistenceMode === "snapshot") {
      push({
        id: "render/keyvalue-persistence",
        severity: memoryOnly ? "error" : "warning",
        line: lineOfKey(kv, kv.node.plan === "free" ? "plan" : "persistenceMode"),
        message: memoryOnly
          ? kv.node.plan === "free"
            ? `Key Value ${name(kv)} uses plan: free. A queue needs a Key Value that saves every write to disk, or a restart loses the queued jobs, and Render's free instance page (https://render.com/docs/free#free-key-value) says how plan: free stores data.`
            : `Key Value ${name(kv)} keeps its data in memory only (persistenceMode: off), so a restart loses every queued job.`
          : `Key Value ${name(kv)} saves snapshots only, so a restart loses the jobs added since the last snapshot.`,
        fix: `${kv.node.plan === "free" ? "Pick a plan that saves data to disk, from Render's pricing page (https://render.com/pricing), and leave" : "Leave"} persistenceMode out, which gives journal-snapshot: every write saved to disk once a second.`,
        docs: `${GUIDE}#create-a-key-value-instance-for-your-queue`,
      });
    }
  }

  // how workers start and stop
  for (const worker of services.filter((r) => r.node.type === "worker")) {
    const start = startCommand(repo, worker);
    if (start && !start.key && /react-router-serve|docker-start|\b(npm|pnpm|yarn)\s+(run\s+)?start\b/.test(expandScripts(repo, start.command))) {
      push({
        id: "render/worker-command",
        severity: "error",
        line: worker.line,
        message: `Worker ${name(worker)} has no dockerCommand, so it runs the Dockerfile's CMD, "${start.command}", which starts the web server instead of your job workers.`,
        fix: "Set dockerCommand to start the worker with node, such as dockerCommand: node build/worker.js.",
        docs: `${GUIDE}#run-workers-on-a-background-worker`,
      });
    } else if (start?.key && /^\s*(pnpm|npm|npx|yarn)\b/.test(start.command)) {
      const pnpm = /^\s*pnpm\b/.test(start.command);
      push({
        id: "render/worker-command",
        severity: pnpm ? "error" : "warning",
        line: lineOfKey(worker, start.key),
        message: pnpm
          ? `Worker ${name(worker)} starts through pnpm, which didn't pass SIGTERM on to Node in a test, so the worker never drains and is killed when its shutdown delay ends.`
          : `Worker ${name(worker)} starts through a package manager. Node's Docker guidance warns that npm can swallow SIGTERM, and then the worker never drains its jobs.`,
        fix: "Start the worker with node and a compiled file, such as dockerCommand: node build/worker.js.",
        docs: `${GUIDE}#run-workers-on-a-background-worker`,
      });
    }

    const delay = worker.node.maxShutdownDelaySeconds;
    if (delay !== undefined && !(Number.isInteger(delay) && delay >= 1 && delay <= 300)) {
      push({
        id: "render/shutdown-delay",
        severity: "error",
        line: lineOfKey(worker, "maxShutdownDelaySeconds"),
        message: `maxShutdownDelaySeconds is ${JSON.stringify(delay)}, and Render accepts whole seconds from 1 to 300.`,
        fix: "Set it to at most 300. Split jobs that run longer than that, or run them as Render Workflows tasks.",
        docs: `${GUIDE}#check-your-host-s-time-limits`,
      });
    } else if (delay === undefined) {
      push({
        id: "render/shutdown-delay",
        severity: "manual",
        line: worker.line,
        message: `Worker ${name(worker)} has no maxShutdownDelaySeconds, so it gets Render's default of 30 seconds between SIGTERM and SIGKILL on every deploy. A job still running then is killed, and BullMQ reruns it from the start.`,
        error: "job stalled more than allowable limit",
        fix: "Compare it with the longest job the inventory lists (an action's timeoutMS). Set maxShutdownDelaySeconds above it, up to 300, and split longer jobs or run them as Workflows tasks.",
        docs: `${GUIDE}#check-your-host-s-time-limits`,
      });
    }
  }

  // migrations and the Prisma client. They count as running when a pre-deploy command or the web
  // service's own start runs them: a worker that migrates as it starts doesn't hold back the web's deploy.
  const prisma = "prisma" in deps || "@prisma/client" in deps;
  let migrates = false;
  for (const service of services.filter((r) => ["web", "worker", "pserv"].includes(r.node.type))) {
    if (typeof service.node.preDeployCommand === "string" && MIGRATES.test(expandScripts(repo, service.node.preDeployCommand))) migrates = true;
    const start = startCommand(repo, service);
    if (!start || !MIGRATES.test(expandScripts(repo, start.command))) continue;
    if (service.node.type === "web") migrates = true;
    // a Dockerfile CMD that migrates is common/migrate-on-start
    if (!start.key) continue;
    push({
      id: "render/migrate-on-start",
      severity: "warning",
      line: lineOfKey(service, start.key),
      message: `${name(service)} runs migrations when it starts, so every instance runs them, and a start that takes over 15 minutes fails the deploy.`,
      fix: "Start the server without migrations, such as dockerCommand: npm run start, and add preDeployCommand: npx prisma migrate deploy to the web service.",
      docs: `${GUIDE}#set-up-development-and-deploys`,
    });
  }
  const web = services.find((r) => r.node.type === "web");
  if (prisma && web && !migrates && repo.find(/(^|\/)migrations\/[^/]+\/migration\.sql$/).length > 0) {
    push({
      id: "render/no-migrations",
      severity: "warning",
      line: lineOfKey(web, web.node.dockerCommand ? "dockerCommand" : "type"),
      message: "Nothing in render.yaml runs prisma migrate deploy: no preDeployCommand, and no start command that migrates.",
      error: "The table `public.Session` does not exist in the current database.",
      fix: "Add preDeployCommand: npx prisma migrate deploy to the web service, unless your deploy pipeline runs migrations before Render deploys.",
      docs: `${GUIDE}#set-up-development-and-deploys`,
    });
  }
  const overridden = services.find((r) => r.node.runtime === "docker" && typeof r.node.dockerCommand === "string" && r.node.type !== "worker") ??
    services.find((r) => r.node.runtime === "docker" && typeof r.node.dockerCommand === "string");
  if (overridden) {
    findings.push(...startOverrideFindings(repo, "render", FILE, lineOfKey(overridden, "dockerCommand"), overridden.node.dockerCommand, `${GUIDE}#set-up-development-and-deploys`, dockerfileOf(repo, overridden)));
  }

  // the web service and webhooks
  for (const service of services.filter((r) => r.node.type === "web")) {
    if (!service.node.healthCheckPath) {
      push({
        id: "render/health-check",
        severity: "warning",
        line: service.line,
        message: `Web service ${name(service)} has no healthCheckPath, so Render sends it traffic as soon as the port opens, and keeps sending it traffic while the database is down.`,
        fix: "Add a route that queries the database, such as /healthz, and set healthCheckPath: /healthz.",
        docs: `${GUIDE}#receive-webhooks`,
      });
    }
    const instances = service.node.numInstances ?? 1;
    const minInstances = service.node.scaling?.minInstances;
    if (isProduction(service) && instances < 2 && !(minInstances >= 2)) {
      push({
        id: "render/single-instance",
        severity: "warning",
        line: lineOfKey(service, service.node.scaling ? "scaling" : "numInstances"),
        message: `Web service ${name(service)} runs one instance, so every webhook fails while Render moves it to another machine, which can take a few minutes.`,
        fix: "Set numInstances: 2, or scaling.minInstances: 2 with autoscaling.",
        docs: `${GUIDE}#receive-webhooks`,
      });
    }
  }

  // databases and Key Value open to the internet
  for (const r of [...databases, ...keyValues]) {
    const list = r.node.ipAllowList;
    const open = Array.isArray(list) && list.some((entry: any) => entry?.source === "0.0.0.0/0");
    if (r.kind === "database" ? list === undefined || open : open) {
      push({
        id: "render/open-to-internet",
        severity: "warning",
        line: list === undefined ? r.line : lineOfKey(r, "ipAllowList"),
        message: `${r.kind === "database" ? "Database" : "Key Value"} ${name(r)} accepts connections from any IP address that has its password${list === undefined ? ", because it has no ipAllowList" : ""}.`,
        fix: "Set ipAllowList: [] so only your Render services in the region connect, and add your own address only while you load records.",
        docs: `${GUIDE}#load-your-records`,
      });
    }
  }

  // migrations through the connection pool
  const { url, directUrl } = prismaUrls(repo);
  for (const service of services) {
    const runsMigrations = [service.node.preDeployCommand, startCommand(repo, service)?.command].some((c) => typeof c === "string" && MIGRATES.test(expandScripts(repo, c)));
    for (const entry of Array.isArray(service.node.envVars) ? service.node.envVars : []) {
      if (entry?.fromDatabase?.property !== "connectionPoolString") continue;
      const migrationVar = entry.key === directUrl || (!directUrl && entry.key === url && runsMigrations);
      if (!migrationVar) continue;
      push({
        id: "render/migrations-through-pool",
        severity: "error",
        line: keyLine(entry.fromDatabase, "property") ?? keyLine(entry, "fromDatabase"),
        message: `${entry.key} on ${name(service)} is the PgBouncer pool, and Prisma Migrate uses it. The pool keeps Migrate's session-level advisory lock on a server connection after Migrate exits, so the next deploy waits for that lock and fails.`,
        error: MIGRATE_LOCK_ERROR,
        fix: `Set ${entry.key} from property: connectionString${directUrl ? "" : ', and add directUrl = env("DIRECT_DATABASE_URL") to the Prisma datasource'}. If a lock is already stuck, run select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and objid = 72707369 on the direct URL.`,
        docs: `${GUIDE}#connect-through-the-connection-pool`,
      });
    }
  }

  // row-level security as the database's own user, which runs the migrations and so owns the tables
  const appVar = url ?? "DATABASE_URL";
  if (services.some((s) => (Array.isArray(s.node.envVars) ? s.node.envVars : []).some((e: any) => e?.key === appVar && e.fromDatabase))) {
    const table = (raw: string) => raw.replace(/"/g, "").split(".").pop()!.toLowerCase();
    const sqlFiles = repo.find(/\.sql$/);
    const forced = new Set(sqlFiles.flatMap((f) => [...(repo.read(f) ?? "").matchAll(/alter\s+table\s+(?:only\s+)?([\w."]+)\s+force\s+row\s+level\s+security/gi)].map((m) => table(m[1]))));
    for (const file of sqlFiles) {
      const sql = repo.read(file) ?? "";
      for (const match of sql.matchAll(/alter\s+table\s+(?:only\s+)?([\w."]+)\s+enable\s+row\s+level\s+security/gi)) {
        if (forced.has(table(match[1]))) continue;
        findings.push({
          id: "render/owner-skips-rls",
          severity: "error",
          file,
          line: lineAt(sql, match.index!),
          message: `${table(match[1])} has row-level security, and the app's ${appVar} comes from fromDatabase, which connects as the database's own user. That user runs the migrations, so it owns the table and skips its policies: a query with no store set returns every store's rows.`,
          fix: `Connect the web service and worker as a role you create with create user, with grants and alter default privileges, and put its URL in a dashboard environment group. Keep DIRECT_DATABASE_URL on the default user for migrations. Forcing row-level security on ${table(match[1])} instead also applies the policies to the default user, but then data migrations and the load script fail with unrecognized configuration parameter "app.shop_id".`,
          docs: `${GUIDE}#set-up-development-and-deploys`,
        });
      }
    }
  }

  // environment groups
  for (const group of all.filter((r) => r.kind === "group")) {
    for (const entry of Array.isArray(group.node.envVars) ? group.node.envVars : []) {
      if (entry?.sync === false) {
        push({
          id: "render/env-group-secret",
          severity: "error",
          line: keyLine(entry, "sync") ?? keyLine(entry, "key"),
          message: `${entry.key} in environment group ${name(group)} has sync: false, which Render doesn't allow in a group, so the variable never gets a value.`,
          fix: "Create the group that holds secrets in the dashboard and link it with fromGroup, or put the sync: false variable on each service.",
          docs: `${GUIDE}#environment-variables`,
        });
      }
      const reference = ["fromDatabase", "fromService", "fromGroup"].find((key) => entry && key in entry);
      if (reference) {
        push({
          id: "render/env-group-reference",
          severity: "error",
          line: keyLine(entry, reference),
          message: `Environment group ${name(group)} uses ${reference}, and a group can't reference a database, a service, or another group, so the Blueprint fails validation.`,
          fix: `Move ${entry.key ?? "this variable"} to each service's envVars, with ${reference} there.`,
          docs: `${GUIDE}#environment-variables`,
        });
      }
    }
  }

  // scheduled work, plans, regions, and disks
  for (const cron of services.filter((r) => r.node.type === "cron")) {
    push({
      id: "render/cron-job",
      severity: "manual",
      line: cron.line,
      message: `Cron job ${name(cron)} starts running on its schedule ("${cron.node.schedule}") as soon as a Blueprint sync creates it, while Gadget's scheduled action still runs.`,
      fix: "Add the cron job to render.yaml and sync it in the cutover's Move scheduled work step, in the same hour you turn off Gadget's scheduler trigger.",
      docs: `${GUIDE}#cut-over-to-the-new-platform`,
    });
  }
  for (const r of [...services, ...databases].filter((r) => r.node.plan === "free" && isProduction(r) && !(r.node.type === "keyvalue" && queues.includes(r) && queueLibrary))) {
    // what production needs from each kind of instance; Render's free instance page lists what plan: free leaves out
    const needs: Record<string, string> = {
      web: "keep running when idle, so the first webhook after a quiet period doesn't wait for it to start, and run its preDeployCommand",
      keyvalue: "save its data to disk",
    };
    push({
      id: "render/free-plan",
      severity: "warning",
      line: lineOfKey(r, "plan"),
      message: `${name(r)} uses plan: free in production, where it has to ${r.kind === "database" ? "keep its data for as long as the app runs and have backups" : (needs[r.node.type] ?? "stay up for production traffic")}. Render's free instance page (https://render.com/docs/free) lists the limits of plan: free.`,
      fix: "Pick a plan that does that from Render's pricing page (https://render.com/pricing).",
      docs: `${GUIDE}#choose-plans`,
    });
  }
  const regions = new Map<string, string>();
  for (const r of [...services, ...databases]) regions.set(`${r.env}\0${r.node.name}`, r.node.region ?? "oregon");
  for (const service of services) {
    const from = service.node.region ?? "oregon";
    for (const entry of Array.isArray(service.node.envVars) ? service.node.envVars : []) {
      const reference = entry?.fromDatabase ? "fromDatabase" : entry?.fromService ? "fromService" : null;
      if (!reference) continue;
      const to = regions.get(`${service.env}\0${entry[reference].name}`);
      if (!to || to === from) continue;
      push({
        id: "render/region",
        severity: "error",
        line: keyLine(entry, reference),
        message: `${name(service)} is in ${from} and ${entry[reference].name} is in ${to}. Render's private network works only within a region, and neither can move after it's created.`,
        fix: "Put every service and database in one region, the same one, before you create them.",
        docs: `${GUIDE}#choose-where-your-app-will-run`,
      });
    }
  }
  for (const service of services.filter((r) => r.node.disk && ["web", "worker", "pserv"].includes(r.node.type))) {
    push({
      id: "render/disk",
      severity: "warning",
      line: lineOfKey(service, "disk"),
      message: `${name(service)} has a persistent disk, so it runs on one instance only, goes down for a few seconds on every deploy, and no other service or one-off job can read its files.`,
      fix: "Keep files in a bucket, such as Amazon S3 or Cloudflare R2, and remove the disk.",
      docs: `${GUIDE}#search-files-and-other-services`,
    });
  }
  return findings;
}

function workflowFindings(repo: Repo): Finding[] {
  const findings: Finding[] = [];
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file);
    // starts made from a rate-limited queue job are fine; starts made anywhere else can burst past the limit
    if (!text || !/@renderinc\/sdk/.test(text) || !/\.startTask\s*\(/.test(text) || /\blimiter\s*:/.test(text)) continue;
    findings.push({
      id: "render/workflows-start",
      severity: "warning",
      file,
      line: lineOf(text, /\.startTask\s*\(/),
      message: "This starts Render Workflows runs directly. Render rejects starts above the workspace's per-minute limit, which depends on its plan (https://render.com/docs/workflows-limits#api-rate-limits), with a 429 instead of queuing them, and nothing here retries them.",
      error: "Failed to run task:",
      fix: "Start each run from a queued job with retries and a rate limit below your workspace's start limit, and copy the task slug from the task's page in the Render Dashboard.",
      docs: `${GUIDE}#run-long-actions-as-workflows-tasks`,
    });
  }
  return findings;
}

export const render: CheckModule = {
  platform: "render",
  title: "Render",
  detect: (repo) => repo.exists(FILE) || "@renderinc/sdk" in repo.dependencies(),
  run: (repo) => {
    const findings = workflowFindings(repo);
    const text = repo.read(FILE);
    if (text === null) return findings;
    let doc: any;
    try {
      doc = parseYaml(text);
    } catch (error) {
      return [
        ...findings,
        {
          id: "render/blueprint-unreadable",
          severity: "manual",
          file: FILE,
          message: `render.yaml couldn't be read by this script (${(error as Error).message}), so none of its Render checks ran.`,
          fix: "Validate it against https://render.com/schema/render.yaml.json, or with render blueprints validate render.yaml when you're logged in, then check the rows of the Checks to run table in references/platforms/render.md by hand.",
          docs: `${GUIDE}#set-up-development-and-deploys`,
        },
      ];
    }
    return [...findings, ...blueprintFindings(repo, doc ?? {})];
  },
  // the Dockerfile's CMD never runs when every Docker service has its own dockerCommand, and
  // render/migrate-on-start checks those commands instead
  suppresses: (repo) => {
    const text = repo.read(FILE);
    if (text === null) return [];
    const docker = resources(parseYaml(text) ?? {}).filter((r) => r.kind === "service" && r.node.runtime === "docker");
    return docker.length > 0 && docker.every((r) => typeof r.node.dockerCommand === "string") ? ["common/migrate-on-start"] : [];
  },
};
