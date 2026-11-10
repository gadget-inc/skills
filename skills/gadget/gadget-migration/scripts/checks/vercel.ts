// Checks for apps moving to Vercel. references/platforms/vercel.md explains each one.
import { DOCS, type CheckModule, type Finding, type Repo } from "./types.ts";
import { lineAt, lineOf, parseJsonc } from "./read-config.ts";
import { expandScripts } from "./common.ts";

const GUIDE = `${DOCS}/vercel`;
const REF = "references/platforms/vercel.md";
const MIGRATES = /migrate\s+deploy|db\s+push|drizzle-kit\s+(migrate|push)|migrate:deploy/;

const isReactRouter = (repo: Repo) => {
  const deps = repo.dependencies();
  return !deps.next && !!(deps["@react-router/dev"] || deps["@vercel/react-router"] || deps["@remix-run/dev"]);
};

// A vercel.json glob as a regular expression: ** crosses folders, * and ? stay inside one, {a,b} is either.
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      out += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      out += `(?:${glob.slice(i + 1, end).split(",").map((p) => p.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|")})`;
      i = end;
    } else out += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

// The source file that serves a URL path, for React Router's flat routes and Next.js.
function routeFile(repo: Repo, path: string): string | null {
  const segments = path.replace(/^\/+|\/+$/g, "").split("/");
  const flat = segments.join(".");
  const candidates = [
    ...["tsx", "ts", "jsx", "js"].flatMap((ext) => [`app/routes/${flat}.${ext}`, `app/routes/${flat}/route.${ext}`]),
    ...["ts", "js"].flatMap((ext) => [`app/${segments.join("/")}/route.${ext}`, `src/app/${segments.join("/")}/route.${ext}`, `pages/${segments.join("/")}.${ext}`]),
  ];
  return candidates.find((c) => repo.exists(c)) ?? null;
}

// The line of the first export of a route handler, such as action, loader, GET, or POST.
const handlerLine = (text: string) => lineOf(text, /export\s+(?:const|let|async\s+function|function)\s+(?:action|loader|GET|POST)\b|export\s*\{[^}]*\bas\s+(?:action|loader|GET|POST)\b/) ?? 1;

const exportsName = (text: string, name: string) =>
  new RegExp(`export\\s+(?:const|let|var|async\\s+function|function)\\s+${name}\\b|export\\s*\\{[^}]*\\bas\\s+${name}\\b[^}]*\\}|export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(text);

function configFindings(repo: Repo, text: string, config: any): Finding[] {
  const findings: Finding[] = [];

  // functions settings
  const functions = config.functions && typeof config.functions === "object" ? Object.keys(config.functions) : [];
  for (const pattern of functions) {
    const line = lineOf(text, `"${pattern}"`);
    if (isReactRouter(repo)) {
      findings.push({
        id: "vercel/functions-react-router",
        severity: "error",
        file: "vercel.json",
        line,
        message: `In a React Router app, the functions section only matches files in an api folder, which Vercel doesn't build next to React Router, so "${pattern}" fails the build.`,
        error: `Error: [unused_function] The pattern "${pattern}" defined in \`functions\` doesn't match any Serverless Functions inside the \`api\` directory.`,
        fix: "Remove the functions section and export const config = { maxDuration: 800 } from the route itself.",
        docs: `${GUIDE}#check-your-host-s-time-limits`,
      });
    } else {
      const regex = globToRegExp(pattern);
      if (!repo.files.some((f) => regex.test(f))) {
        findings.push({
          id: "vercel/functions-no-match",
          severity: "warning",
          file: "vercel.json",
          line,
          message: `The functions pattern "${pattern}" matches no file in the repository. A Next.js build doesn't fail on it, so its maxDuration and triggers apply to nothing.`,
          fix: "Correct the pattern to the route file's path, such as app/api/inngest/route.ts.",
          docs: `${GUIDE}#check-your-host-s-time-limits`,
        });
      }
    }
  }

  // schedules
  const schedules = config.schedules && typeof config.schedules === "object" ? (Object.entries(config.schedules) as [string, any][]) : [];
  const crons: any[] = Array.isArray(config.crons) ? config.crons : [];
  if (schedules.length || crons.length) {
    const key = schedules.length ? "schedules" : "crons";
    findings.push({
      id: "vercel/schedules-before-cutover",
      severity: "manual",
      file: "vercel.json",
      line: lineOf(text, `"${key}"`),
      message: `vercel.json declares ${schedules.length + crons.length} schedule${schedules.length + crons.length === 1 ? "" : "s"}. Vercel turns on a production schedule as soon as a production deployment declares it, so a deploy before the switch runs each job in Gadget and here.`,
      fix: 'Before the switch, run vercel schedules list --environment production and check that each schedule is inactive. Turn one off with vercel schedules disable <name>, or add the section in the cutover\'s "Move scheduled work" deploy.',
      docs: `${GUIDE}#cut-over-to-the-new-platform`,
    });
  }
  const sourceMentionsSecret = repo.sourceFiles().some((f) => (repo.read(f) ?? "").includes("CRON_SECRET"));
  const targets = [
    ...schedules.map(([name, s]) => ({ name, path: s?.path, method: String(s?.requestMethod ?? "POST").toUpperCase(), line: lineOf(text, new RegExp(`"${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`)) })),
    // Vercel's older Cron Jobs call their path with GET
    ...crons.map((c) => ({ name: String(c?.path), path: c?.path, method: "GET", line: lineOf(text, `"${c?.path}"`) })),
  ];
  for (const target of targets) {
    if (typeof target.path !== "string") continue;
    const file = routeFile(repo, target.path.split("?")[0]);
    const route = file ? (repo.read(file) ?? "") : "";
    if (file && !route.includes("CRON_SECRET")) {
      findings.push({
        id: "vercel/schedule-unprotected",
        severity: "error",
        file,
        line: handlerLine(route),
        message: `The schedule "${target.name}" calls ${target.path}, which is a public URL, and this route doesn't check CRON_SECRET, so anyone can run the job.`,
        fix: 'Set CRON_SECRET and return 401 unless request.headers.get("authorization") is `Bearer ${process.env.CRON_SECRET}`, before doing any work.',
        docs: `${GUIDE}#replace-scheduled-actions`,
      });
    } else if (!file && !sourceMentionsSecret) {
      findings.push({
        id: "vercel/schedule-unprotected",
        severity: "warning",
        file: "vercel.json",
        line: target.line,
        message: `The schedule "${target.name}" calls ${target.path}, a public URL, and no source file checks CRON_SECRET.`,
        fix: "Check the Authorization header against CRON_SECRET in the route before doing any work.",
        docs: `${GUIDE}#replace-scheduled-actions`,
      });
    }
    if (!file) continue;
    const reactRouterRoute = file.startsWith("app/routes/");
    const handler = reactRouterRoute ? (target.method === "GET" ? "loader" : "action") : target.method;
    if (!exportsName(route, handler)) {
      const routeId = file.replace(/^app\//, "").replace(/\.[jt]sx?$/, "");
      findings.push({
        id: "vercel/schedule-method",
        severity: "error",
        file,
        line: handlerLine(route),
        message: `The schedule "${target.name}" sends ${target.method}${target.method === "POST" ? ", Vercel Schedules' default," : ""} and this route exports no ${handler}, so every run gets 405.`,
        error: reactRouterRoute
          ? `You made a ${target.method} request to "${target.path}" but did not provide ${handler === "action" ? "an `action`" : "a `loader`"} for route "${routeId}", so there is no way to handle the request.`
          : "405 Method Not Allowed",
        fix: reactRouterRoute
          ? `Export the work as the route's ${handler}, or set "requestMethod": "${target.method === "POST" ? "GET" : "POST"}" on the schedule to match the route.`
          : `Export ${target.method} from the route, or set the schedule's requestMethod to the method the route exports.`,
        docs: `${GUIDE}#replace-scheduled-actions`,
      });
    }
  }
  return findings;
}

function codeFindings(repo: Repo, config: any): Finding[] {
  const findings: Finding[] = [];
  // vercel.json functions settings reach route files only outside React Router
  const functionPatterns = isReactRouter(repo) ? [] : Object.entries(config?.functions ?? {}).map(([p, v]: [string, any]) => ({ regex: globToRegExp(p), maxDuration: v?.maxDuration }));
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file);
    if (!text) continue;

    // the route Inngest calls for every step, with Vercel's default 300 seconds
    const serve = text.match(/import\s*\{[^}]*\bserve\b[^}]*\}\s*from\s*["']inngest\/[\w-]+["']/);
    if (serve && !/maxDuration/.test(text) && !functionPatterns.some((p) => p.regex.test(file) && p.maxDuration)) {
      findings.push({
        id: "vercel/inngest-max-duration",
        severity: "warning",
        file,
        line: lineAt(text, serve.index!),
        message: "Inngest runs every step through this route, which stops at Vercel's default maximum duration of 300 seconds. A step that runs longer, such as an action that ran for 12 minutes on Gadget, fails at 5 minutes on every retry.",
        error: "504 FUNCTION_INVOCATION_TIMEOUT",
        fix: isReactRouter(repo)
          ? "Add export const config = { maxDuration: 800 } to this route (800 seconds is Pro's maximum)."
          : "Add export const maxDuration = 800 to this route, or a functions entry for it in vercel.json.",
        docs: `${GUIDE}#check-your-host-s-time-limits`,
      });
    }

    if (/webhook/i.test(file) && /\bwaitUntil\s*\(/.test(text) && /["']@vercel\/functions["']/.test(text)) {
      findings.push({
        id: "vercel/webhook-waituntil",
        severity: "warning",
        file,
        line: lineOf(text, /\bwaitUntil\s*\(/),
        message: "This webhook route hands work to waitUntil, which keeps the function running after it responds but never retries. Processing that fails once is lost, and Shopify won't resend a webhook that got a 200.",
        fix: "Send the work to a queue that retries, such as an Inngest event with the webhook id as its id.",
        docs: `${GUIDE}#choose-a-job-queue`,
      });
    }

    const pool = text.match(/new\s+Pool\s*\(/);
    if (pool && /from\s+["']pg["']/.test(text) && !/attachDatabasePool/.test(text)) {
      findings.push({
        id: "vercel/pg-pool",
        severity: "warning",
        file,
        line: lineAt(text, pool.index!),
        message: "A pg pool that isn't registered with attachDatabasePool keeps idle connections open while Vercel suspends the function instance, and those count against the database's connection limit.",
        error: "remaining connection slots are reserved",
        fix: 'Call attachDatabasePool(pool) from "@vercel/functions" right after creating the pool.',
        docs: `${GUIDE}#use-a-connection-pooler`,
      });
    }

    const multipart = text.match(/from\s+["'](@mjackson\/form-data-parser|@remix-run\/form-data-parser|multer|busboy|formidable)["']|unstable_parseMultipartFormData/);
    if (multipart) {
      findings.push({
        id: "vercel/multipart-upload",
        severity: "warning",
        file,
        line: lineAt(text, multipart.index!),
        message: "This parses file uploads sent to the server. A Vercel Function accepts request bodies up to 4.5MB, where Gadget accepted 100MB, so a 20MB upload that worked on Gadget fails.",
        error: "413 FUNCTION_PAYLOAD_TOO_LARGE",
        fix: "Upload from the browser straight to storage, with Blob's client uploads or a presigned S3 URL, and save the object's key on the record.",
        docs: `${GUIDE}#file-storage`,
      });
    }
  }
  return findings;
}

// A Vercel deployment or branch URL, such as my-app-4f9c2a1bc-my-team.vercel.app or my-app-git-main-my-team.vercel.app,
// as opposed to a production alias such as my-app.vercel.app or my-app-my-team.vercel.app
function deploymentUrl(text: string): { url: string; index: number } | null {
  for (const match of text.matchAll(/https:\/\/([a-z0-9-]+)\.vercel\.app/g)) {
    const segments = match[1].split("-").slice(1);
    if (segments.includes("git") || segments.some((s) => s.length >= 7 && s.length <= 9 && /\d/.test(s) && /[a-z]/.test(s))) return { url: match[0], index: match.index! };
  }
  return null;
}

function shopifyTomlFindings(repo: Repo): Finding[] {
  const findings: Finding[] = [];
  for (const file of repo.find(/^shopify\.app(\.[\w-]+)?\.toml$/)) {
    const text = repo.read(file) ?? "";
    const match = deploymentUrl(text);
    if (!match) continue;
    findings.push({
      id: "vercel/deployment-url",
      severity: "error",
      file,
      line: lineAt(text, match.index),
      message: `${match.url} is the URL of one deployment. It changes with every deployment, and Deployment Protection blocks Shopify's requests to it.`,
      fix: "Use the environment's own domain, such as https://app.example.com for production or https://staging.example.com for staging.",
      docs: `${GUIDE}#cut-over-to-the-new-platform`,
    });
  }
  return findings;
}

function manualFindings(repo: Repo): Finding[] {
  const findings: Finding[] = [];
  const scripts = repo.scripts();
  const buildScript = scripts["vercel-build"] !== undefined ? "vercel-build" : "build";
  const build = expandScripts(repo, scripts[buildScript] ?? "");
  if (MIGRATES.test(build)) {
    findings.push({
      id: "vercel/preview-database",
      severity: "manual",
      file: "package.json",
      line: lineOf(repo.read("package.json") ?? "", `"${buildScript}"`),
      message: `The ${buildScript} script runs migrations, and Vercel runs it for preview deployments too. If Preview shares Production's DATABASE_URL, as it does after a plain vercel install neon, every branch's preview build migrates the production database.`,
      fix: "Run vercel env ls and check that no DATABASE_URL or DATABASE_URL_UNPOOLED row lists Production and Preview together. Give Preview its own database, such as Neon's preview branching.",
      docs: `${GUIDE}#map-your-models-to-database-tables`,
    });
  }
  if (repo.find(/^shopify\.app(\.[\w-]+)?\.toml$/).length) {
    findings.push({
      id: "vercel/deployment-protection",
      severity: "manual",
      message: `Standard Deployment Protection covers every domain except production domains, so Shopify's webhooks and the embedded app on a staging domain stop at Vercel's sign-in${"inngest" in repo.dependencies() ? ", and Inngest's calls to deployment URLs fail" : ""}.`,
      fix: `In the project's Settings > Deployment Protection, add the staging domain as a Deployment Protection Exception${"inngest" in repo.dependencies() ? ", and add the protection bypass secret to Inngest's Vercel integration" : ""}. Then curl -s -o /dev/null -w "%{http_code}\\n" https://staging.example.com/auth/login should print the app's 200, not 401.`,
      docs: `${GUIDE}#set-up-development-and-deploys`,
    });
  }
  return findings;
}

export const vercel: CheckModule = {
  platform: "vercel",
  title: "Vercel",
  detect: (repo) => repo.exists("vercel.json") || repo.exists(".vercel/project.json") || "@vercel/react-router" in repo.dependencies() || "@vercel/functions" in repo.dependencies(),
  // Vercel builds the app itself and never runs the template's Dockerfile, and it has no cron processes
  suppresses: () => ["common/migrate-on-start", "common/cron-script-exit"],
  run: (repo) => {
    const findings: Finding[] = [];
    let config: any = {};
    const text = repo.read("vercel.json");
    if (text !== null) {
      try {
        config = parseJsonc(text) ?? {};
        findings.push(...configFindings(repo, text, config));
      } catch (error) {
        findings.push({
          id: "vercel/config-unreadable",
          severity: "manual",
          file: "vercel.json",
          message: `vercel.json couldn't be read (${(error as Error).message}), so its functions and schedules weren't checked.`,
          fix: `Check it by hand against ${REF}, or run vercel build and read its errors.`,
          docs: GUIDE,
        });
      }
    }
    findings.push(...codeFindings(repo, config), ...shopifyTomlFindings(repo), ...manualFindings(repo));
    return findings;
  },
};
