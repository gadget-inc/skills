// Checks the new app's code and config for the pitfalls in references/platforms/*.md.
// Usage: node scripts/preflight.ts [app directory] [--platform render,fly-io] [--json]
// Node 22.18+ or 23.6+, no dependencies. It reads files as text, so it reports what it can see:
// each finding says what it found, the error it causes, and the fix. "Check by hand" findings
// are things only a dashboard, CLI, or database query can show.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { CheckModule, Finding, Repo } from "./checks/types.ts";
import { common } from "./checks/common.ts";
import { vercel } from "./checks/vercel.ts";
import { render } from "./checks/render.ts";
import { railway } from "./checks/railway.ts";
import { flyIo } from "./checks/fly-io.ts";
import { googleCloud } from "./checks/google-cloud.ts";
import { supabase } from "./checks/supabase.ts";
import { cloudflare } from "./checks/cloudflare.ts";
import { hookdeck } from "./checks/hookdeck.ts";
import { inngest } from "./checks/inngest.ts";
import { triggerDev } from "./checks/trigger-dev.ts";

export const MODULES: CheckModule[] = [common, vercel, render, railway, flyIo, googleCloud, supabase, cloudflare, hookdeck, inngest, triggerDev];

const SKIP_DIRS = new Set(["node_modules", ".git", "build", "dist", ".react-router", ".cache", ".next", ".vercel", ".wrangler", ".gadget", "coverage", ".turbo"]);
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const NOT_APP_CODE = /(^|\/)(test|tests|__tests__|fixtures|e2e)\/|\.(test|spec)\.[jt]sx?$|\.d\.ts$/;

export function openRepo(root: string): Repo {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        files.push(relative(root, join(dir, entry.name)).split(sep).join("/"));
      }
    }
  };
  walk(root);
  files.sort();
  const cache = new Map<string, string | null>();
  const read = (path: string) => {
    if (!cache.has(path)) {
      try {
        const full = join(root, path);
        cache.set(path, statSync(full).size > 2_000_000 ? null : readFileSync(full, "utf8"));
      } catch {
        cache.set(path, null);
      }
    }
    return cache.get(path)!;
  };
  const fileSet = new Set(files);
  let pkg: any;
  const packageJson = () => {
    if (pkg === undefined) {
      try {
        pkg = JSON.parse(read("package.json") ?? "{}");
      } catch {
        pkg = {};
      }
    }
    return pkg;
  };
  return {
    root,
    files,
    exists: (path) => fileSet.has(path),
    read,
    find: (pattern) => files.filter((f) => pattern.test(f)),
    sourceFiles: () => files.filter((f) => SOURCE.test(f) && !NOT_APP_CODE.test(f)),
    dependencies: () => ({ ...packageJson().devDependencies, ...packageJson().dependencies }),
    scripts: () => ({ ...packageJson().scripts }),
  };
}

// A manual finding when the directory isn't the app's own: a workspace root whose apps live in
// subdirectories, or a --platform whose files aren't here. Every check reads package.json, the
// Dockerfile, and platform config at the root, so either case would otherwise print "No findings".
function directoryFindings(root: string, repo: Repo, only: string[] | undefined): Finding[] {
  let pkg: any = {};
  try {
    pkg = JSON.parse(repo.read("package.json") ?? "{}");
  } catch {}
  const workspace = pkg?.workspaces ? "package.json has workspaces" : repo.exists("pnpm-workspace.yaml") ? "it has a pnpm-workspace.yaml" : null;
  const missing = MODULES.filter((m) => m.platform !== "common" && only?.includes(m.platform) && !m.detect(repo));
  if (!workspace && !missing.length) return [];

  // directories below this one with a package.json, nearest first, and the platforms each one looks like
  const atRoot = new Set(MODULES.filter((m) => m.platform !== "common" && m.detect(repo)).map((m) => m.platform));
  const below = repo
    .find(/\/package\.json$/)
    .map((f) => f.slice(0, -"/package.json".length))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
    .slice(0, 30)
    .map((dir) => {
      const sub = openRepo(join(root, dir));
      return { dir, platforms: MODULES.filter((m) => m.platform !== "common" && m.detect(sub)).map((m) => m.platform), start: "start" in sub.scripts() };
    });
  const named = (dirs: string[]) => (dirs.length > 3 ? `${dirs.slice(0, 3).join(", ")}, and ${dirs.length - 3} more` : dirs.join(", "));
  const forced = only?.length ? ` --platform ${only.join(",")}` : "";

  const elsewhere = below.filter((b) => missing.some((m) => b.platforms.includes(m.platform))).map((b) => b.dir);
  const notHere: Finding = {
    id: "common/app-directory",
    severity: "manual",
    message: `--platform ${missing.map((m) => m.platform).join(",")} was given, and nothing in this directory looks like a ${missing.map((m) => m.title).join(" or ")} app, so those checks had nothing to read${elsewhere.length ? `. ${named(elsewhere)} ${elsewhere.length > 1 ? "do" : "does"}` : ""}.`,
    fix: elsewhere.length
      ? `Run preflight on ${elsewhere[0]}, the app's own directory, instead${forced ? `, with${forced}` : ""}.`
      : "Run preflight in the app's own directory, the one with its package.json and the platform's config file, or add that config first.",
  };
  if (missing.length && elsewhere.length) return [notHere];
  // Shopify's template lists its extensions as workspaces, so a root that is the app itself doesn't count
  const apps = workspace ? below.filter((b) => b.platforms.some((p) => !atRoot.has(p)) || (b.start && !("start" in repo.scripts()) && !repo.exists("Dockerfile"))).map((b) => b.dir) : [];
  if (!apps.length) return missing.length ? [notHere] : [];
  return [
    {
      id: "common/app-directory",
      severity: "manual",
      message: `This is a workspace root (${workspace}), and preflight reads package.json, the Dockerfile, and platform config only in the directory it's given, so it didn't check ${named(apps)}.`,
      fix: `Run preflight on each app's own directory instead, such as ${apps[0]}${forced ? `, with${forced}` : ""}.`,
    },
  ];
}

export function preflight(root: string, only?: string[]): { platforms: CheckModule[]; findings: Finding[] } {
  const repo = openRepo(root);
  const platforms = MODULES.filter((m) => m.platform === "common" || (only ? only.includes(m.platform) : m.detect(repo)));
  const findings: Finding[] = [...directoryFindings(root, repo, only)];
  for (const module of platforms) {
    try {
      findings.push(...module.run(repo));
    } catch (error) {
      findings.push({
        id: `${module.platform}/could-not-check`,
        severity: "manual",
        message: `The ${module.title} checks stopped: ${(error as Error).message}`,
        fix: `Check references/platforms/${module.platform}.md by hand.`,
      });
    }
  }
  const suppressed = new Set<string>();
  for (const module of platforms) {
    try {
      for (const id of module.suppresses?.(repo) ?? []) suppressed.add(id);
    } catch {
      // a module that can't decide suppresses nothing
    }
  }
  return { platforms, findings: findings.filter((f) => !suppressed.has(f.id)) };
}

const ORDER = { error: 0, warning: 1, manual: 2 } as const;
const HEADINGS = { error: "Errors", warning: "Warnings", manual: "Check by hand" } as const;

export function report(root: string, platforms: CheckModule[], findings: Finding[]): string {
  const out: string[] = [`# Preflight for ${root}`, ""];
  out.push(`Checked: ${platforms.map((p) => p.title).join(", ")}. Each platform's reference is references/platforms/<name>.md.`, "");
  const sorted = [...findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.id.localeCompare(b.id));
  for (const severity of ["error", "warning", "manual"] as const) {
    const group = sorted.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    out.push(`## ${HEADINGS[severity]} (${group.length})`, "");
    for (const f of group) {
      const where = f.file ? ` \`${f.file}${f.line ? `:${f.line}` : ""}\`` : "";
      out.push(`- **${f.id}**${where}: ${f.message}`);
      if (f.error) out.push(`  - You'll see: \`${f.error}\``);
      out.push(`  - Fix: ${f.fix}`);
      if (f.docs) out.push(`  - Why: ${f.docs}`);
    }
    out.push("");
  }
  if (findings.length === 0) out.push("No findings. That covers only what the files show: read the platform reference's checks that need a dashboard or CLI.", "");
  return out.join("\n");
}

// import.meta.main needs Node 24.2, so compare paths instead
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const platformIndex = args.indexOf("--platform");
  const only = platformIndex >= 0 ? args[platformIndex + 1]?.split(",").map((s) => s.trim()) : undefined;
  const dir = args.find((a, i) => !a.startsWith("--") && (platformIndex < 0 || i !== platformIndex + 1)) ?? ".";
  const root = resolve(dir);
  const unknown = only?.filter((p) => !MODULES.some((m) => m.platform === p));
  if (unknown?.length) {
    console.error(`unknown platform: ${unknown.join(", ")}. Known: ${MODULES.map((m) => m.platform).join(", ")}`);
    process.exit(2);
  }
  const { platforms, findings } = preflight(root, only);
  console.log(json ? JSON.stringify({ platforms: platforms.map((p) => p.platform), findings }, null, 2) : report(dir, platforms, findings));
  process.exit(findings.some((f) => f.severity === "error") ? 1 : 0);
}
