// Checks for apps moving to Fly.io. references/platforms/fly-io.md explains each one.
import { DOCS, type CheckModule, type Finding, type Repo } from "./types.ts";
import { keyLine, lineAt, lineOf, parseDockerfile, parseToml } from "./read-config.ts";
import { dockerfileCmd, dockerfilePath, expandScripts, startOverrideFindings } from "./common.ts";
import { closing, mask } from "./source-scan.ts";

const GUIDE = `${DOCS}/fly-io`;
const REF = "references/platforms/fly-io.md";

interface FlyConfig {
  file: string;
  text: string;
  config: any;
}

// fly.toml and every fly.<name>.toml at the root, such as fly.staging.toml
function flyConfigs(repo: Repo, findings: Finding[]): FlyConfig[] {
  const out: FlyConfig[] = [];
  for (const file of repo.find(/^fly(\.[\w-]+)?\.toml$/)) {
    const text = repo.read(file) ?? "";
    try {
      out.push({ file, text, config: parseToml(text) });
    } catch (error) {
      findings.push({
        id: "fly-io/unreadable-config",
        severity: "manual",
        file,
        message: `The checks couldn't read ${file} (${(error as Error).message}), so none of the Fly.io config checks ran on it.`,
        fix: `Run fly config validate --strict -c ${file}, then check it against ${REF} by hand.`,
      });
    }
  }
  return out;
}

// The Dockerfile a config builds: [build] dockerfile, or Dockerfile. Null for a prebuilt image or a
// buildpack builder, where there's no Dockerfile to read.
function dockerfileOf(config: any): string | null {
  const build = config.build && typeof config.build === "object" ? config.build : {};
  if (build.image || build.builder || build.buildpacks) return null;
  return dockerfilePath(build.dockerfile);
}

const lower = (value: unknown) => (typeof value === "string" ? value.toLowerCase() : value);

// kill_timeout in seconds: a number, or a duration string such as "300s" or "5m"
function seconds(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) return undefined;
  const n = Number(match[1]);
  return { ms: n / 1000, s: n, m: n * 60, h: n * 3600 }[match[2] ?? "s"];
}

// The process groups an [http_service] or [[services]] block serves. With no [processes], the one group is "app".
function servedGroups(config: any): { groups: Set<string>; services: any[] } {
  const services = [config.http_service, ...(Array.isArray(config.services) ? config.services : [])].filter(Boolean);
  const groups = new Set<string>();
  for (const service of services) for (const group of Array.isArray(service.processes) ? service.processes : ["app"]) groups.add(group);
  return { groups, services };
}

interface SignalUse {
  file: string;
  line: number;
  term: boolean;
  int: boolean;
  worker: boolean;
}

function signalHandlers(repo: Repo): SignalUse[] {
  const out: SignalUse[] = [];
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file) ?? "";
    // process.on("SIGTERM", ...), or a loop such as for (const s of ["SIGTERM", "SIGINT"]) process.on(s, ...)
    if (!/process\.(on|once)\(/.test(text)) continue;
    const term = /["'`]SIGTERM["'`]/.test(text);
    if (!term) continue;
    out.push({
      file,
      line: lineOf(text, /process\.(on|once)\(\s*["'`]SIGTERM["'`]/) ?? lineOf(text, /["'`]SIGTERM["'`]/) ?? 1,
      term,
      int: /["'`]SIGINT["'`]/.test(text),
      worker: /new Worker\s*\(/.test(text),
    });
  }
  return out;
}

function hasWorker(repo: Repo, config: any): boolean {
  if (repo.sourceFiles().some((f) => /new Worker\s*\(/.test(repo.read(f) ?? "") && /from\s+["']bullmq["']/.test(repo.read(f) ?? ""))) return true;
  const { groups } = servedGroups(config);
  const processes = config.processes && typeof config.processes === "object" ? config.processes : {};
  return Object.entries(processes).some(([group, command]) => !groups.has(group) && !/supercronic/.test(String(command)));
}

function configFindings(repo: Repo, { file, text, config }: FlyConfig, handlers: SignalUse[]): Finding[] {
  const findings: Finding[] = [];
  const processes: Record<string, string> = config.processes && typeof config.processes === "object" ? config.processes : {};
  const { groups, services } = servedGroups(config);
  const worker = hasWorker(repo, config);

  // kill_signal: Fly.io sends SIGINT unless told otherwise
  const signal = String(config.kill_signal ?? "SIGINT").toUpperCase();
  const termOnly = handlers.filter((h) => h.term && !h.int);
  if (signal !== "SIGTERM" && termOnly.length) {
    const workerFile = termOnly.find((h) => h.worker);
    const target = workerFile ?? termOnly[0];
    findings.push({
      id: "fly-io/kill-signal",
      severity: workerFile ? "error" : "warning",
      file,
      line: keyLine(config, "kill_signal") ?? 1,
      message: workerFile
        ? `Fly.io stops a Machine with ${signal} unless kill_signal says otherwise, and ${target.file} only handles SIGTERM. Node exits at once on a SIGINT it doesn't handle, in the middle of the worker's jobs, and npm exits with code 130.`
        : `Fly.io stops a Machine with ${signal} unless kill_signal says otherwise, and the SIGTERM handler in ${target.file} never runs. A web server that keeps its Redis connection open then waits the full kill_timeout on every deploy.`,
      fix: 'Set kill_signal = "SIGTERM" at the top of the file. It applies to every process group.',
      docs: `${GUIDE}#check-your-host-s-time-limits`,
    });
  }

  // kill_timeout: 5 seconds by default, 300 at most
  const timeout = seconds(config.kill_timeout);
  if (worker && config.kill_timeout === undefined) {
    findings.push({
      id: "fly-io/kill-timeout",
      severity: "warning",
      file,
      line: 1,
      message: "This app runs a worker, and Fly.io waits only 5 seconds after the stop signal by default before it forces the Machine to stop. Every job that needs longer is cut off by each deploy and fly secrets set.",
      fix: "Set kill_timeout = 300, the most Fly.io allows, and split jobs that run longer than that.",
      docs: `${GUIDE}#check-your-host-s-time-limits`,
    });
  } else if (timeout !== undefined && timeout > 300) {
    findings.push({
      id: "fly-io/kill-timeout",
      severity: "warning",
      file,
      line: keyLine(config, "kill_timeout"),
      message: `kill_timeout is ${timeout} seconds, and Fly.io waits at most 300, as best effort.`,
      fix: "Set kill_timeout = 300, and split jobs that run longer than 5 minutes or run them on Machines of their own.",
      docs: `${GUIDE}#check-your-host-s-time-limits`,
    });
  }

  // auto_stop_machines on the group that receives webhooks
  for (const service of services) {
    const stop = lower(service.auto_stop_machines);
    if (stop === undefined || stop === "off" || stop === false) continue;
    const min = Number(service.min_machines_running ?? 0);
    findings.push({
      id: "fly-io/web-auto-stop",
      severity: "warning",
      file,
      line: keyLine(service, "auto_stop_machines"),
      message:
        min > 0
          ? `auto_stop_machines is ${JSON.stringify(service.auto_stop_machines)}, and min_machines_running = ${min} keeps only ${min} Machine running, in the primary region only. When that Machine's host fails, the next webhook waits for a stopped Machine to boot.`
          : `auto_stop_machines is ${JSON.stringify(service.auto_stop_machines)}, which stops every web Machine when traffic is quiet. The first webhook after a quiet night waits for a Machine to boot and the app to start, and Shopify fails deliveries that take more than 5 seconds.`,
      fix: 'Set auto_stop_machines = "off" on the service that receives webhooks, and run 2 web Machines.',
      docs: `${GUIDE}#receive-webhooks`,
    });
  }

  // a crontab in a group with a service runs on 2 Machines
  for (const [group, command] of Object.entries(processes)) {
    if (!/supercronic|\bcrond\b/.test(String(command)) || !groups.has(group)) continue;
    findings.push({
      id: "fly-io/cron-in-web",
      severity: "error",
      file,
      line: keyLine(processes, group),
      message: `The ${group} group runs the crontab and also serves HTTP. fly deploy starts 2 Machines for a group with a service, so every scheduled job runs twice.`,
      fix: `Run the crontab in a group of its own, such as cron = "supercronic /app/crontab", and leave it out of the service's processes list.`,
      docs: `${GUIDE}#replace-scheduled-actions`,
    });
  }

  // migrations on every start instead of once in release_command
  const migrators = Object.entries(processes).filter(([, command]) => /migrate deploy|db push/.test(expandScripts(repo, String(command))));
  for (const [group, command] of migrators) {
    findings.push({
      id: "fly-io/migrate-on-start",
      severity: "warning",
      file,
      line: keyLine(processes, group),
      message: `The ${group} group starts with "${command}", which runs migrations every time one of its Machines starts${config.deploy?.release_command ? ", on top of release_command" : ""}. A webhook that wakes a Machine waits for them.`,
      fix: 'Start it with npm run start, and run migrations once per deploy with release_command = "npx prisma migrate deploy" under [deploy].',
      docs: `${GUIDE}#run-migrations-once-per-deploy`,
    });
  }
  const hasMigrations = repo.files.some((f) => /(^|\/)prisma\/migrations\/[^/]+\/migration\.sql$/.test(f));
  const dockerfile = dockerfileOf(config);
  const cmdMigrates = !Object.keys(processes).length && !!dockerfile && /migrate deploy|db push/.test(expandScripts(repo, dockerfileCmd(repo, dockerfile)?.command ?? ""));
  if (hasMigrations && !config.deploy?.release_command && !migrators.length && !cmdMigrates) {
    findings.push({
      id: "fly-io/no-release-command",
      severity: "warning",
      file,
      line: keyLine(config, "deploy") ?? keyLine(config, "processes") ?? 1,
      message: "The app has Prisma migrations, and nothing in this config runs them: there's no release_command, and no process runs prisma migrate deploy.",
      error: "The table `public.Session` does not exist in the current database.",
      fix: 'Add release_command = "npx prisma migrate deploy" under [deploy], with the direct database URL available to it.',
      docs: `${GUIDE}#run-migrations-once-per-deploy`,
    });
  }

  // [processes] commands replace the Dockerfile's CMD, which ran prisma generate in the template
  for (const [group, command] of dockerfile ? Object.entries(processes) : []) {
    const found = startOverrideFindings(repo, "fly-io", file, keyLine(processes, group), String(command), `${GUIDE}#run-migrations-once-per-deploy`, dockerfile!);
    if (found.length) {
      findings.push(found[0]);
      break;
    }
  }

  // [env] names that Fly.io reserves
  const env = config.env && typeof config.env === "object" ? config.env : {};
  for (const name of Object.keys(env).filter((n) => n.startsWith("FLY_"))) {
    findings.push({
      id: "fly-io/env-fly-prefix",
      severity: "warning",
      file,
      line: keyLine(env, name),
      message: `${name} starts with FLY_, and Fly.io's configuration reference says [env] names cannot.`,
      fix: "Rename it, such as APP_ENV for what GADGET_ENV held.",
      docs: `${GUIDE}#environment-variables`,
    });
  }

  // values the frontend build reads must be build args, not [env]
  const buildArgs = config.build?.args && typeof config.build.args === "object" ? config.build.args : {};
  const viteNames = new Set<string>();
  for (const source of repo.sourceFiles()) for (const match of (repo.read(source) ?? "").matchAll(/import\.meta\.env\.(\w+)/g)) viteNames.add(match[1]);
  for (const name of Object.keys(env)) {
    if (!viteNames.has(name) || name in buildArgs) continue;
    findings.push({
      id: "fly-io/build-time-variable",
      severity: "error",
      file,
      line: keyLine(env, name),
      message: `${name} is read through import.meta.env, so the build writes its value into the frontend bundle, and [env] values only exist while Machines run, not while Fly.io builds the image. The bundle gets undefined.`,
      fix: `Move ${name} to [build.args] and add ARG ${name} to the Dockerfile before RUN npm run build.`,
      docs: `${GUIDE}#environment-variables`,
    });
  }
  return findings;
}

// [build.args] that the Dockerfile never declares with ARG never reach the build
function buildArgFindings(repo: Repo, configs: FlyConfig[]): Finding[] {
  const findings: Finding[] = [];
  for (const { file, config } of configs) {
    const path = dockerfileOf(config);
    const dockerfile = path ? repo.read(path) : null;
    if (!dockerfile) continue;
    const steps = parseDockerfile(dockerfile);
    const args = config.build?.args && typeof config.build.args === "object" ? config.build.args : {};
    for (const name of Object.keys(args)) {
      if (steps.some((s) => s.instruction === "ARG" && s.args.split(/[=\s]/)[0] === name)) continue;
      findings.push({
        id: "fly-io/build-arg-unused",
        severity: "error",
        file,
        line: keyLine(args, name),
        message: `${name} is a build arg, but ${path} has no ARG ${name}, so the build never sees it. Docker's BuildKit prints no warning, and the value is empty.`,
        fix: `Add ARG ${name} to ${path} before the step that reads it, such as RUN npm run build.`,
        docs: `${GUIDE}#environment-variables`,
      });
    }
  }
  return findings;
}

function cronFindings(repo: Repo, configs: FlyConfig[]): Finding[] {
  const findings: Finding[] = [];
  // the supercronic commands, grouped by the Dockerfile their config builds
  const byDockerfile = new Map<string, { file: string; line: number | undefined; command: string }[]>();
  for (const { file, config } of configs) {
    const path = dockerfileOf(config);
    if (!path) continue;
    for (const [group, command] of Object.entries(config.processes && typeof config.processes === "object" ? config.processes : {})) {
      if (!/supercronic/.test(String(command))) continue;
      byDockerfile.set(path, [...(byDockerfile.get(path) ?? []), { file, line: keyLine(config.processes, group), command: String(command) }]);
    }
  }
  const seen = new Set<string>();
  for (const [path, commands] of byDockerfile) {
    const dockerfile = repo.read(path);
    if (dockerfile === null) continue;
    if (!/supercronic/.test(dockerfile)) {
      const first = commands[0];
      findings.push({
        id: "fly-io/supercronic-missing",
        severity: "error",
        file: first.file,
        line: first.line,
        message: `"${first.command}" runs Supercronic, and ${path} never installs it, so the cron Machine can't start its command.`,
        fix: `Download Supercronic in ${path} with its checksum, as in the Dockerfile in references/platforms/fly-io.md.`,
        docs: `${GUIDE}#run-migrations-once-per-deploy`,
      });
    }

    // CRON_TZ on an alpine image without tzdata
    const steps = parseDockerfile(dockerfile);
    const base = steps.filter((s) => s.instruction === "FROM").pop()?.args ?? "";
    const alpine = /alpine/.test(base);
    const tzdata = steps.some((s) => s.instruction === "RUN" && /apk add[^&;|]*\btzdata\b/.test(s.args));
    if (!alpine || tzdata) continue;
    for (const { command } of commands) {
      const crontab = command.split(/\s+/).filter((w, i) => i > 0 && !w.startsWith("-")).pop();
      if (!crontab) continue;
      const local = [crontab.replace(/^\/app\//, ""), crontab.replace(/^\//, ""), crontab.split("/").pop()!].find((p) => repo.exists(p));
      if (!local || seen.has(local)) continue;
      seen.add(local);
      const text = repo.read(local) ?? "";
      const match = text.match(/^\s*CRON_TZ\s*=\s*(\S+)/m);
      if (!match || /^(UTC|Etc\/UTC)$/.test(match[1])) continue;
      findings.push({
        id: "fly-io/cron-tz",
        severity: "error",
        file: local,
        line: lineAt(text, match.index!),
        message: `The crontab sets CRON_TZ=${match[1]}, and the ${base.split(/\s+/)[0]} image has no time zone data, so Supercronic exits and runs no jobs.`,
        error: `unknown time zone ${match[1]}`,
        fix: `Add tzdata to the apk add line in ${path}, such as RUN apk add --no-cache openssl tzdata.`,
        docs: `${GUIDE}#replace-scheduled-actions`,
      });
    }
  }
  return findings;
}

// Two configs that name the same app deploy over each other
function duplicateAppFindings(configs: FlyConfig[]): Finding[] {
  const findings: Finding[] = [];
  const seen = new Map<string, string>();
  for (const { file, config } of configs) {
    if (typeof config.app !== "string") continue;
    const other = seen.get(config.app);
    if (other) {
      findings.push({
        id: "fly-io/duplicate-app",
        severity: "error",
        file,
        line: keyLine(config, "app"),
        message: `${file} and ${other} both deploy the app "${config.app}", so fly deploy --config ${file} replaces that app's Machines with this config.`,
        fix: `Give each environment its own Fly.io app, such as app = "${config.app}-staging", created with fly apps create.`,
        docs: `${GUIDE}#environments`,
      });
    } else {
      seen.set(config.app, file);
    }
  }
  return findings;
}

// fly launch's Dockerfile generator rewrites shopify.app.toml and runs shopify app deploy
function launchFindings(repo: Repo, configs: FlyConfig[]): Finding[] {
  const apps = configs.map((c) => c.config.app).filter((a): a is string => typeof a === "string");
  if (!apps.length) return [];
  const dockerfiles = new Set(configs.map((c) => dockerfileOf(c.config)).filter((p): p is string => !!p));
  const generated = [...dockerfiles].some((p) => /LABEL\s+fly_launch_runtime=/.test(repo.read(p) ?? ""));
  const findings: Finding[] = [];
  for (const file of repo.find(/^shopify\.app(\.[\w-]+)?\.toml$/)) {
    const text = repo.read(file) ?? "";
    const app = apps.find((a) => text.includes(`https://${a}.fly.dev`));
    if (!app) continue;
    const fingerprint = /\/auth\/shopify\/callback"/.test(text) && /\/api\/auth\/callback"/.test(text);
    if (!generated && !fingerprint) continue;
    findings.push({
      id: "fly-io/launch-rewrote-shopify-toml",
      severity: "warning",
      file,
      line: lineOf(text, `https://${app}.fly.dev`),
      message: `${file} points at https://${app}.fly.dev, the way fly launch's Dockerfile generator rewrites it before running shopify app deploy. If this file's client_id is your production Shopify app, every store's app URL and webhooks may already point at the new app, before its database holds any records.`,
      fix: "Check the app's active version with shopify app versions list --config <this file>. If it points at Fly.io too early, run shopify app deploy from a copy of the TOML with Gadget's URLs. Create apps with fly apps create, never fly launch, in a project linked to production.",
      docs: `${GUIDE}#create-the-app-without-fly-launch`,
    });
  }
  return findings;
}

// The web server keeps running after SIGTERM while a Redis connection is open
function webShutdownFindings(repo: Repo, configs: FlyConfig[], handlers: SignalUse[]): Finding[] {
  const longest = configs.map((c) => ({ c, s: seconds(c.config.kill_timeout) ?? 5 })).sort((a, b) => b.s - a.s)[0];
  if (!longest || longest.s <= 30) return [];
  const opener = repo
    .sourceFiles()
    .filter((f) => f.startsWith("app/"))
    .find((f) => {
      const text = repo.read(f) ?? "";
      return !/new Worker\s*\(/.test(text) && /new (Queue|IORedis|Redis)\s*\(/.test(text) && /from\s+["'](bullmq|ioredis)["']/.test(text);
    });
  if (!opener) return [];
  if (handlers.some((h) => !h.worker && h.file.startsWith("app/"))) return [];
  const text = repo.read(opener) ?? "";
  return [
    {
      id: "fly-io/web-shutdown",
      severity: "warning",
      file: opener,
      line: lineOf(text, /new (Queue|IORedis|Redis)\s*\(/),
      message: `The web server loads this Redis connection, and no file the web server loads closes it on SIGTERM. Node keeps running while it's open, so every deploy and fly secrets set waits the full kill_timeout of ${longest.s} seconds for each web Machine.`,
      fix: "Close the queue and its connection on SIGTERM in app/entry.server.tsx, as in references/platforms/common.md.",
      docs: `${GUIDE}#check-your-host-s-time-limits`,
    },
  ];
}

// ioredis before 5.8.2 looks up IPv4 only, and Fly.io's private network is IPv6
function ioredisFindings(repo: Repo): Finding[] {
  let version: string | undefined;
  try {
    version = JSON.parse(repo.read("package-lock.json") ?? "{}").packages?.["node_modules/ioredis"]?.version;
  } catch {
    // an unreadable lockfile leaves the exact version from package.json
  }
  version ??= repo.dependencies().ioredis?.match(/^\d+\.\d+\.\d+$/)?.[0];
  if (!version) return [];
  const [major, minor, patch] = version.split(".").map(Number);
  if (major > 5 || (major === 5 && (minor > 8 || (minor === 8 && patch >= 2)))) return [];
  const findings: Finding[] = [];
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file) ?? "";
    if (!/from\s+["']ioredis["']/.test(text)) continue;
    const code = mask(text, false);
    for (const match of code.matchAll(/new (?:IORedis|Redis)\s*\(/g)) {
      const open = match.index! + match[0].length - 1;
      const close = closing(text, open);
      if (close < 0) continue;
      const args = text.slice(open, close + 1);
      // family in the options or the URL (?family=6), or in an options object the call names, such as new IORedis(url, options)
      if (/family/.test(args)) continue;
      const named = [...args.matchAll(/[(,]\s*([A-Za-z_$][\w$]*)\s*(?=[,)])/g)].map((m) => m[1]);
      if (named.some((name) => new RegExp(`\\b(?:const|let|var)\\s+${name}\\b[^=]*=\\s*\\{[^;]*\\bfamily\\b`).test(text))) continue;
      findings.push({
        id: "fly-io/ioredis-family",
        severity: "warning",
        file,
        line: lineAt(text, match.index!),
        message: `ioredis ${version} looks up IPv4 addresses only unless family is set, and Fly.io's private network, where Upstash Redis lives, is IPv6 only. The script can't see your Redis URL, so a URL that ends with ?family=6 already fixes it.`,
        error: "getaddrinfo ENOTFOUND",
        fix: "Pass family: 6 (or 0) in the ioredis options, add ?family=6 to the Redis URL, or upgrade ioredis to 5.8.2 or later.",
        docs: `${GUIDE}#create-a-redis-database-for-your-queue`,
      });
    }
  }
  return findings;
}

export const flyIo: CheckModule = {
  platform: "fly-io",
  title: "Fly.io",
  detect: (repo) => repo.find(/^fly(\.[\w-]+)?\.toml$/).length > 0,
  // With [processes] in every config, Fly.io never starts the Dockerfile's CMD, so common/migrate-on-start
  // is about a command that doesn't run. fly-io/migrate-on-start checks the [processes] commands instead.
  suppresses: (repo) => {
    const configs = flyConfigs(repo, []);
    const allOverride = configs.length > 0 && configs.length === repo.find(/^fly(\.[\w-]+)?\.toml$/).length && configs.every((c) => c.config.processes && Object.keys(c.config.processes).length > 0);
    return allOverride ? ["common/migrate-on-start"] : [];
  },
  run: (repo) => {
    const findings: Finding[] = [];
    const configs = flyConfigs(repo, findings);
    const handlers = signalHandlers(repo);
    for (const config of configs) findings.push(...configFindings(repo, config, handlers));
    findings.push(...buildArgFindings(repo, configs), ...cronFindings(repo, configs), ...duplicateAppFindings(configs), ...launchFindings(repo, configs), ...webShutdownFindings(repo, configs, handlers), ...ioredisFindings(repo));
    return findings;
  },
};
