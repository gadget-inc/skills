// Checks for apps moving to Cloudflare. references/platforms/cloudflare.md explains each one.
import { DOCS, type CheckModule, type Finding, type Repo } from "./types.ts";
import { keyLine, lineAt, lineOf, parseJsoncWithLines, parseToml } from "./read-config.ts";
import { expandScripts } from "./common.ts";
import { mask } from "./source-scan.ts";

const GUIDE = `${DOCS}/cloudflare`;
const REF = "references/platforms/cloudflare.md";
const CONFIG_FILES = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"];

// Keys a Wrangler environment doesn't inherit from the top of the file. From the "not automatically
// inherited" notes in wrangler 4.160.0's config-schema.json, plus durable_objects, which Cloudflare's
// configuration docs list as non-inheritable too.
const NOT_INHERITED = [
  "vars", "secrets", "define", "durable_objects", "hyperdrive", "workflows", "queues", "r2_buckets", "kv_namespaces",
  "d1_databases", "services", "send_email", "ai", "vectorize", "analytics_engine_datasets", "browser", "images",
  "dispatch_namespaces", "mtls_certificates", "tail_consumers", "pipelines", "secrets_store_secrets", "ratelimits",
];

interface Wrangler {
  file: string;
  text: string;
  config: any;
  // the 1-based line of a key path, such as ["env", "staging", "hyperdrive"], or the nearest parent found
  line(path: (string | number)[]): number | undefined;
}


function readWrangler(repo: Repo): Wrangler | { file: string; error: string } | null {
  const file = CONFIG_FILES.find((f) => repo.exists(f));
  if (!file) return null;
  const text = repo.read(file) ?? "";
  try {
    const config = file.endsWith(".toml") ? parseToml(text) : parseJsoncWithLines(text);
    const lookup = (target: any, key: string | number) => keyLine(target, key);
    return {
      file,
      text,
      config,
      line(path) {
        let target = config;
        let found: number | undefined;
        for (const key of path) {
          if (!target || typeof target !== "object") break;
          found = lookup(target, key) ?? found;
          target = target[key];
        }
        return found;
      },
    };
  } catch (error) {
    return { file, error: (error as Error).message };
  }
}

// The deployable Workers in the file: the top level, and each environment.
function scopes(w: Wrangler): { name: string; node: any; path: string[] }[] {
  const out = [{ name: "the top level", node: w.config, path: [] as string[] }];
  for (const [name, node] of Object.entries(w.config.env ?? {})) out.push({ name: `env.${name}`, node, path: ["env", name] });
  return out;
}

const usesVitePlugin = (repo: Repo) => "@cloudflare/vite-plugin" in repo.dependencies();

// Wrangler alone doesn't mean the app runs on Workers: an app on another host installs it to manage R2
// buckets or KV. A Wrangler config file or the Vite plugin does.
const runsOnWorkers = (repo: Repo) => CONFIG_FILES.some((f) => repo.exists(f)) || usesVitePlugin(repo);

// A host besides Workers that runs long-lived processes or the Dockerfile, such as Fly.io running a BullMQ
// worker while the web app runs on Workers, or Cloudflare Containers. Returns the file that shows it.
function processHost(repo: Repo, w: Wrangler | null): string | null {
  const config = repo.files.find((f) => /^(fly(\.[\w-]+)?\.toml|render\.yaml|railway\.(json|toml)|\.railway\/railway\.ts|Procfile|cloudbuild\.yaml|app\.yaml)$/.test(f));
  if (config) return config;
  const deploy = repo.find(/\.(sh|ya?ml)$/).find((f) => /gcloud run (deploy|jobs)|\bfly(ctl)? deploy\b/.test(repo.read(f) ?? ""));
  if (deploy) return deploy;
  return w && scopes(w).some((s) => s.node?.containers) ? w.file : null;
}

// Whether vite.config stops a build that has no CLOUDFLARE_ENV, as the one in cloudflare.md does, so a
// script that builds without it fails at once instead of deploying the top-level Worker.
function viteRequiresEnv(repo: Repo): boolean {
  const file = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"].find((f) => repo.exists(f));
  const text = file ? mask(repo.read(file) ?? "", false) : "";
  return /!\s*process\.env\.CLOUDFLARE_ENV\b[^;{}]*\)\s*(?:\{\s*)?(?:this\.error|throw)\b|assert\s*\(\s*process\.env\.CLOUDFLARE_ENV\b/.test(text);
}

// ---------------------------------------------------------------------------------------------

function configFindings(repo: Repo, w: Wrangler): Finding[] {
  const findings: Finding[] = [];
  const envs = Object.entries(w.config.env ?? {}) as [string, any][];

  // bindings at the top that an environment leaves out
  for (const key of NOT_INHERITED) {
    if (!(key in w.config)) continue;
    for (const [name, node] of envs) {
      if (node && typeof node === "object" && !(key in node)) {
        findings.push({
          id: "cloudflare/env-not-inherited",
          severity: "error",
          file: w.file,
          line: w.line(["env", name]),
          message: `"${key}" is set at the top of ${w.file} but not in env.${name}, and environments don't inherit it, so the ${name} Worker deploys without it.`,
          error: `"${key}" exists at the top level, but not on "env.${name}".`,
          fix: `Copy "${key}" into env.${name}, with ${name}'s own resource names and ids.`,
          docs: `${GUIDE}#set-up-development-and-deploys`,
        });
      }
    }
  }

  // one queue, Workflow, bucket, database, or KV namespace used by two environments
  const seen = new Map<string, string>();
  for (const scope of scopes(w)) {
    const node = scope.node ?? {};
    const names: { label: string; value: unknown; path: (string | number)[] }[] = [];
    (node.queues?.producers ?? []).forEach((q: any, i: number) => names.push({ label: "queue", value: q?.queue, path: [...scope.path, "queues", "producers", i] }));
    (node.queues?.consumers ?? []).forEach((q: any, i: number) => names.push({ label: "queue", value: q?.queue, path: [...scope.path, "queues", "consumers", i] }));
    (node.workflows ?? []).forEach((x: any, i: number) => names.push({ label: "Workflow", value: x?.name, path: [...scope.path, "workflows", i] }));
    (node.r2_buckets ?? []).forEach((x: any, i: number) => names.push({ label: "R2 bucket", value: x?.bucket_name, path: [...scope.path, "r2_buckets", i] }));
    (node.hyperdrive ?? []).forEach((x: any, i: number) => names.push({ label: "Hyperdrive configuration", value: x?.id, path: [...scope.path, "hyperdrive", i] }));
    (node.d1_databases ?? []).forEach((x: any, i: number) => names.push({ label: "D1 database", value: x?.database_id, path: [...scope.path, "d1_databases", i] }));
    (node.kv_namespaces ?? []).forEach((x: any, i: number) => names.push({ label: "KV namespace", value: x?.id, path: [...scope.path, "kv_namespaces", i] }));
    const own = new Set<string>();
    for (const { label, value, path } of names) {
      if (typeof value !== "string" || !value || /^<.*>$/.test(value)) continue;
      const key = `${label}:${value}`;
      const other = seen.get(key);
      if (other && other !== scope.name && !own.has(key)) {
        findings.push({
          id: "cloudflare/shared-resource-name",
          severity: "error",
          file: w.file,
          line: w.line(path),
          message: `${scope.name} and ${other} both use the ${label} "${value}". Names and ids belong to the whole Cloudflare account, so both Workers reach the same one: a staging consumer takes production's jobs and runs them with staging's code.`,
          fix: `Give each environment its own ${label}, such as "${value.replace(/^my-app/, "my-app-staging")}" for staging.`,
          docs: `${GUIDE}#set-up-development-and-deploys`,
        });
      }
      own.add(key);
      if (!other) seen.set(key, scope.name);
    }
  }

  // cron schedules
  for (const scope of scopes(w)) {
    const crons: unknown[] = scope.node?.triggers?.crons ?? [];
    crons.forEach((cron, index) => {
      if (typeof cron !== "string") return;
      const weekday = cron.trim().split(/\s+/)[4];
      if (weekday && /\d/.test(weekday)) {
        findings.push({
          id: "cloudflare/cron-weekday",
          severity: "warning",
          file: w.file,
          line: w.line([...scope.path, "triggers", "crons", index]),
          message: `"${cron}" gives the weekday as a number. Cloudflare numbers weekdays from 1 for Sunday, where most cron systems use 0 for Sunday, so 1 runs on Sunday here and on Monday elsewhere.`,
          fix: "Write weekdays as MON to SUN, such as 0 9 * * MON.",
          docs: `${GUIDE}#replace-scheduled-actions`,
        });
      }
    });
    if (crons.length > 0) {
      findings.push({
        id: "cloudflare/crons-before-cutover",
        severity: "manual",
        file: w.file,
        line: w.line([...scope.path, "triggers", "crons"]),
        message: `${scope.name} declares ${crons.length} Cron Trigger${crons.length === 1 ? "" : "s"}, which start running when this deploys. Deployed before the switch, each scheduled job runs in Gadget and here.`,
        fix: 'Before the switch, check the Worker\'s Settings > Trigger events in the Cloudflare dashboard: production should have no Cron Triggers until the cutover\'s "Move scheduled work" deploy. To turn them off, deploy "crons": [], because removing the triggers section leaves deployed schedules running.',
        docs: `${GUIDE}#cut-over-to-the-new-platform`,
      });
    }
  }

  // queue consumers on the default 3 retries
  for (const scope of scopes(w)) {
    (scope.node?.queues?.consumers ?? []).forEach((consumer: any, index: number) => {
      if (consumer && consumer.max_retries === undefined) {
        findings.push({
          id: "cloudflare/queue-max-retries",
          severity: "warning",
          file: w.file,
          line: w.line([...scope.path, "queues", "consumers", index]),
          message: `The consumer of "${consumer.queue}" has no max_retries, so Cloudflare deletes a message after 3 retries. A Gadget background action retried 6 times, and message.retry() calls past the limit never run.`,
          fix: "Set max_retries to at least the number of retries your consumer's code counts, such as 6.",
          docs: `${GUIDE}#limit-concurrency-per-store`,
        });
      }
    });
  }

  // Hyperdrive without a placement hint; placement is inherited, so one finding covers every environment
  const withHyperdrive = scopes(w).filter((s) => (s.node?.hyperdrive ?? []).length > 0);
  const unplaced = withHyperdrive.filter((s) => !s.node.placement && !w.config.placement);
  if (unplaced.length) {
    findings.push({
      id: "cloudflare/no-placement",
      severity: "warning",
      file: w.file,
      line: w.line([...unplaced[0].path, "hyperdrive"]),
      message: `${unplaced.map((s) => s.name).join(", ")} reach${unplaced.length === 1 ? "es" : ""} Postgres through Hyperdrive with no placement hint, so each request runs in the data center nearest whoever sent it. A page that makes 20 queries from across an ocean waits about 500ms for the database instead of 40ms.`,
      fix: 'Add "placement": { "region": "aws:us-east-1" } with your database\'s cloud region at the top of the file, where every environment inherits it.',
      docs: `${GUIDE}#run-your-worker-next-to-your-database`,
    });
  }

  // Hyperdrive caching, which only the dashboard or CLI shows
  const hyperdrives = scopes(w).flatMap((s) => (s.node?.hyperdrive ?? []).map((h: any) => String(h?.id ?? "")));
  if (hyperdrives.length) {
    findings.push({
      id: "cloudflare/hyperdrive-caching",
      severity: "manual",
      file: w.file,
      line: w.line(["env"]) ?? w.line(["hyperdrive"]),
      message: "Hyperdrive caches reads for 60 seconds unless caching is off, a write doesn't clear the cache, and with row-level security a cached result for one store can answer the same query from another store.",
      fix: `Run npx wrangler hyperdrive get <id> for ${hyperdrives.join(", ")} and confirm "caching": { "disabled": true }. If not, run npx wrangler hyperdrive update <id> --caching-disabled.`,
      docs: `${GUIDE}#connect-through-hyperdrive`,
    });
  }

  // presigned R2 uploads need a CORS rule on the bucket
  const deps = repo.dependencies();
  if (deps.aws4fetch || deps["@aws-sdk/s3-request-presigner"]) {
    const buckets = scopes(w).flatMap((s) => (s.node?.r2_buckets ?? []).map((b: any) => String(b?.bucket_name ?? "")));
    findings.push({
      id: "cloudflare/r2-cors",
      severity: "manual",
      file: w.file,
      line: w.line(["env"]) ?? w.line(["r2_buckets"]),
      message: "The app signs S3 URLs. A browser uploading to R2 with a presigned PUT URL is blocked unless the bucket has a CORS rule for your app's origin.",
      fix: `Run npx wrangler r2 bucket cors list <bucket> for ${buckets.join(", ") || "each bucket"}. If a bucket has no rule for your app's origin, save the r2-cors.json from ${REF} and run npx wrangler r2 bucket cors set <bucket> --file r2-cors.json.`,
      docs: `${GUIDE}#search-files-and-other-services`,
    });
  }
  return findings;
}

function scriptFindings(repo: Repo, w: Wrangler | null): Finding[] {
  const findings: Finding[] = [];
  const pkg = repo.read("package.json") ?? "";
  const scripts = repo.scripts();
  const hasEnvs = !!w && Object.keys(w.config.env ?? {}).length > 0;
  for (const [name, script] of Object.entries(scripts)) {
    const expanded = expandScripts(repo, script);
    const line = lineOf(pkg, `"${name}"`);

    // a build for one environment, or none, deployed as another
    const deploy = expanded.match(/wrangler\s+(?:deploy|versions\s+upload)\b([^&|;]*)/);
    if (deploy && usesVitePlugin(repo) && /\b(react-router|vite)\s+build\b/.test(expanded)) {
      const target = deploy[1].match(/(?:--env|-e)[=\s]+([\w-]+)/)?.[1];
      const built = expanded.match(/CLOUDFLARE_ENV=([\w-]+)/)?.[1];
      const guarded = viteRequiresEnv(repo);
      if (target && built && target !== built) {
        findings.push({
          id: "cloudflare/build-env-mismatch",
          severity: "error",
          file: "package.json",
          line,
          message: `The "${name}" script builds for ${built} and deploys with --env ${target}. The Vite plugin writes the build's environment into its output, so wrangler refuses.`,
          error: `You have specified the environment "${target}" via the \`--env/-e\` CLI argument. This does not match the target environment "${built}" that was used when building the application.`,
          fix: `Build with CLOUDFLARE_ENV=${target}, then run wrangler deploy without --env.`,
          docs: `${GUIDE}#set-up-development-and-deploys`,
        });
      } else if (target && !built) {
        // --env doesn't choose what a Vite plugin build deploys: the build's CLOUDFLARE_ENV does
        findings.push({
          id: "cloudflare/build-env-mismatch",
          severity: guarded ? "warning" : "error",
          file: "package.json",
          line,
          message: guarded
            ? `The "${name}" script deploys with --env ${target} and builds without CLOUDFLARE_ENV. The build follows CLOUDFLARE_ENV, not --env, so the script only works when the shell that runs it sets CLOUDFLARE_ENV=${target}; without it, vite.config stops the build.`
            : `The "${name}" script deploys with --env ${target} and builds without CLOUDFLARE_ENV. The build follows CLOUDFLARE_ENV, not --env, so unless the shell sets CLOUDFLARE_ENV=${target}, wrangler deploys the top-level Worker${w ? `, named "${w.config.name}",` : ""} with only the top-level bindings.`,
          error: guarded ? undefined : "No bindings found.",
          fix: `Build with CLOUDFLARE_ENV=${target} in the script, then run wrangler deploy without --env.`,
          docs: `${GUIDE}#set-up-development-and-deploys`,
        });
      } else if (!built && hasEnvs && !guarded) {
        // a script meant to run as CLOUDFLARE_ENV=staging npm run deploy is fine, which the script can't see
        findings.push({
          id: "cloudflare/build-env-mismatch",
          severity: "warning",
          file: "package.json",
          line,
          message: `The "${name}" script builds without CLOUDFLARE_ENV, and vite.config doesn't require it. When the shell that runs the script doesn't set CLOUDFLARE_ENV, wrangler deploy publishes the top-level Worker, named "${w!.config.name}", with only the top-level bindings.`,
          error: "No bindings found.",
          fix: `Run it as CLOUDFLARE_ENV=staging npm run ${name}, and add the require-cloudflare-env plugin from the vite.config.ts in ${REF} so a build without it stops, or set CLOUDFLARE_ENV in the script.`,
          docs: `${GUIDE}#set-up-development-and-deploys`,
        });
      }
    }

    // wrangler types without --env makes environment-only bindings optional
    if (/wrangler\s+types\b/.test(expanded) && hasEnvs) {
      const typesArgs = expanded.match(/wrangler\s+types\b([^&|;]*)/)![1];
      const topLevelBindings = NOT_INHERITED.some((k) => k !== "vars" && k !== "secrets" && k in w!.config);
      if (!/(?:--env|-e)[=\s]+[\w-]+/.test(typesArgs) && !topLevelBindings) {
        findings.push({
          id: "cloudflare/types-without-env",
          severity: "warning",
          file: "package.json",
          line,
          message: `The "${name}" script runs wrangler types without --env. Every binding in ${w!.file} is inside an environment, so the generated Env marks each one optional.`,
          error: "error TS18048: 'env.HYPERDRIVE' is possibly 'undefined'.",
          fix: "Run wrangler types --env production --strict-vars=false.",
          docs: `${GUIDE}#connect-through-hyperdrive`,
        });
      }
      const viteConfig = ["vite.config.ts", "vite.config.mts", "vite.config.js"].map((f) => [f, repo.read(f)] as const).find(([, t]) => t);
      const assigned = viteConfig?.[1]?.match(/process\.env\.([A-Z0-9_]+)\s*=(?!=)/);
      const declared = assigned && scopes(w!).some((s) => s.node?.vars && assigned[1] in s.node.vars);
      if (assigned && declared && !/--strict-vars[= ]false|--no-strict-vars/.test(typesArgs)) {
        findings.push({
          id: "cloudflare/types-strict-vars",
          severity: "warning",
          file: viteConfig![0],
          line: lineOf(viteConfig![1]!, assigned[0]),
          message: `wrangler types types each var as its literal value, and ${viteConfig![0]} assigns process.env.${assigned[1]}, as Shopify's template does, so tsc fails.`,
          error: "error TS2322: Type 'string' is not assignable to type '\"https://app.example.com\"'.",
          fix: `Add --strict-vars=false to the "${name}" script.`,
          docs: `${GUIDE}#connect-through-hyperdrive`,
        });
      }
    }
  }
  return findings;
}

function codeFindings(repo: Repo, elsewhere: string | null): Finding[] {
  const findings: Finding[] = [];
  const deps = repo.dependencies();
  const hasAdapter = Object.keys(deps).some((d) => d.startsWith("@prisma/adapter-"));
  let prismaReported = false;

  for (const file of repo.sourceFiles()) {
    const source = repo.read(file);
    if (!source) continue;
    // comments blanked, so a note about renderToPipeableStream or new Worker() isn't a use of it
    const text = mask(source, false);

    if (/(^|\/)entry\.server\.[jt]sx?$/.test(file) && /\brenderToPipeableStream\b/.test(text)) {
      findings.push({
        id: "cloudflare/entry-pipeable-stream",
        severity: "error",
        file,
        line: lineOf(text, /\brenderToPipeableStream\b/),
        message: "This entry file renders with renderToPipeableStream, which needs Node streams. Workers has web streams, so every page fails.",
        error: "TypeError: server_browserExports.renderToPipeableStream is not a function",
        fix: `Render with renderToReadableStream and keep the call to addDocumentResponseHeaders, as in the entry file in ${REF}.`,
        docs: `${GUIDE}#run-shopify-s-app-template-on-workers`,
      });
    }

    if (!hasAdapter && !prismaReported && /from\s+["']@prisma\/client["']/.test(text)) {
      prismaReported = true;
      findings.push({
        id: "cloudflare/prisma-client",
        severity: "error",
        file,
        line: lineOf(text, /from\s+["']@prisma\/client["']/),
        message: "This imports Prisma's default client, as Shopify's template does, and no Prisma driver adapter is installed. The default client doesn't load on Workers, so every request fails.",
        error: 'Error: No such module "assets/.prisma/client/default".',
        fix: "Use node-postgres through Hyperdrive with a client opened per request, or create a Prisma client per request with @prisma/adapter-pg as Prisma's Cloudflare guide shows.",
        docs: `${GUIDE}#run-shopify-s-app-template-on-workers`,
      });
    }

    const pgStorage = text.match(/new\s+PostgreSQLSessionStorage\s*\(/);
    if (pgStorage) {
      findings.push({
        id: "cloudflare/postgres-session-storage",
        severity: "error",
        file,
        line: lineAt(text, pgStorage.index!),
        message: "Shopify's PostgreSQL session storage connects and creates its tables in its constructor. Created when the module loads, it fails every request; created per call, it sends 7 statements per lookup and concurrent calls on an empty database race to create the tables.",
        error: "Disallowed operation called within global scope. Asynchronous I/O (ex: fetch() or connect()), setting a timeout, and generating random values are not allowed within global scope.",
        fix: "Write the five SessionStorage methods on a client opened per request, with one statement each, as the guide's workerSessionStorage does.",
        docs: `${GUIDE}#run-shopify-s-app-template-on-workers`,
      });
    }

    // a database client created when the module loads, which the next request can't use
    const moduleClient = text.match(/^(?:export\s+)?(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*(?:new\s+(?:Client|Pool)\s*\(|postgres\s*\()/m);
    if (moduleClient && /from\s+["'](pg|postgres)["']/.test(text)) {
      findings.push({
        id: "cloudflare/module-scope-client",
        severity: "error",
        file,
        line: lineAt(text, moduleClient.index!),
        message: "This creates a database client when the module loads. On Workers that fails every route with the global-scope error, because all routes share one server build, and a client kept from one request for the next makes the second request hang until the runtime cancels it.",
        error: "Disallowed operation called within global scope. Asynchronous I/O (ex: fetch() or connect()), setting a timeout, and generating random values are not allowed within global scope.",
        fix: "Open a client inside each request with env.HYPERDRIVE.connectionString and close it in finally, as the guide's withDb helper does. Hyperdrive keeps the connections to Postgres warm.",
        docs: `${GUIDE}#connect-through-hyperdrive`,
      });
    }

    if (/from\s+["']@shopify\/shopify-app-session-storage-kv["']/.test(text)) {
      findings.push({
        id: "cloudflare/kv-session-storage",
        severity: "warning",
        file,
        line: lineOf(text, "@shopify/shopify-app-session-storage-kv"),
        message: "Sessions in Workers KV: a KV write can take 60 seconds or more to reach other data centers, and expiring offline tokens change every hour, so a job elsewhere can read a token from before the refresh.",
        fix: "Keep sessions in Postgres, as in the guide's workerSessionStorage.",
        docs: `${GUIDE}#run-shopify-s-app-template-on-workers`,
      });
    }

    if (/from\s+["']bullmq["']/.test(text) && /new\s+Worker\s*\(/.test(text)) {
      findings.push({
        id: "cloudflare/long-running-worker",
        severity: elsewhere ? "warning" : "error",
        file,
        line: lineOf(text, /new\s+Worker\s*\(/),
        message: elsewhere
          ? `A BullMQ worker waits for jobs in a process that runs all the time, which a Worker can't be. ${elsewhere} sets up a host that can run it, so this works only if the worker starts there, from an entry file the Worker never imports.`
          : "A BullMQ worker waits for jobs in a process that runs all the time. A Worker only runs while it handles a request or another event, so this has nowhere to run.",
        fix: elsewhere
          ? `Start the worker only on the host ${elsewhere} configures, or move the jobs to Workflows or Queues.`
          : "Move the jobs to Workflows or Queues, or to a queue that calls the app over HTTP, such as Inngest.",
        docs: `${GUIDE}#replace-background-and-scheduled-actions`,
      });
    }

    if (/\.r2\.dev\b/.test(text)) {
      findings.push({
        id: "cloudflare/r2-dev-url",
        severity: "warning",
        file,
        line: lineOf(text, /\.r2\.dev\b/),
        message: "Files served from the bucket's r2.dev address, which Cloudflare rate limits and means for testing.",
        fix: "Connect a custom domain to the bucket and serve public files from it.",
        docs: `${GUIDE}#search-files-and-other-services`,
      });
    }

    if (/webhook/i.test(file) && /\bwaitUntil\s*\(/.test(text)) {
      findings.push({
        id: "cloudflare/webhook-waituntil",
        severity: "warning",
        file,
        line: lineOf(text, /\bwaitUntil\s*\(/),
        message: "This webhook route hands work to waitUntil, which runs for at most 30 seconds after the response and never retries. Processing that fails once, or takes 40 seconds, is lost, and Shopify won't resend a webhook that got a 200.",
        fix: "Start a Workflow with the webhook id as the instance id, as the guide's webhook route does.",
        docs: `${GUIDE}#receive-webhooks`,
      });
    }
  }

  // a generated Env with optional bindings
  const generated = repo.find(/(^|\/)worker-configuration\.d\.ts$/)[0];
  const types = generated ? (repo.read(generated) ?? "") : "";
  const optional = types.match(/^\s+(\w+)\?: (Hyperdrive|Workflow|Queue|R2Bucket|DurableObjectNamespace|KVNamespace|D1Database)\b/m);
  if (optional) {
    findings.push({
      id: "cloudflare/types-without-env",
      severity: "warning",
      file: generated,
      line: lineAt(types, optional.index! + optional[0].indexOf(optional[1])),
      message: `This Env marks ${optional[1]} optional, which wrangler types does for a binding that only appears inside an environment when it runs without --env.`,
      error: `error TS18048: 'env.${optional[1]}' is possibly 'undefined'.`,
      fix: "Regenerate it with wrangler types --env production --strict-vars=false.",
      docs: `${GUIDE}#connect-through-hyperdrive`,
    });
  }
  return findings;
}

export const cloudflare: CheckModule = {
  platform: "cloudflare",
  title: "Cloudflare",
  detect: runsOnWorkers,
  // Workers never run the template's Dockerfile, have no cron processes, and never send SIGTERM:
  // cloudflare/long-running-worker reports a BullMQ worker instead. That holds only while nothing else
  // runs processes: with Containers, or a Fly.io, Render, Railway, or Cloud Run config beside wrangler,
  // the Dockerfile, the worker, and its scripts may run there, so their common findings stand.
  suppresses: (repo) => {
    const w = readWrangler(repo);
    if (processHost(repo, w && !("error" in w) ? w : null)) return [];
    return ["common/migrate-on-start", "common/cron-script-exit", "common/worker-sigterm"];
  },
  run: (repo) => {
    const findings: Finding[] = [];
    const w = readWrangler(repo);
    if (w && "error" in w) {
      findings.push({
        id: "cloudflare/config-unreadable",
        severity: "manual",
        file: w.file,
        message: `${w.file} couldn't be read (${w.error}), so its environments, bindings, and crons weren't checked.`,
        fix: `Check it by hand against the configuration checks in ${REF}, or run npx wrangler deploy --dry-run --env <name> for each environment and read its warnings.`,
        docs: `${GUIDE}#set-up-development-and-deploys`,
      });
    } else if (w) {
      findings.push(...configFindings(repo, w));
    }
    const config = w && !("error" in w) ? w : null;
    findings.push(...scriptFindings(repo, config), ...codeFindings(repo, processHost(repo, config)));
    return findings;
  },
};
