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
import { googleCloudRun } from "./checks/google-cloud-run.ts";
import { supabase } from "./checks/supabase.ts";
import { cloudflare } from "./checks/cloudflare.ts";
import { hookdeck } from "./checks/hookdeck.ts";
import { inngest } from "./checks/inngest.ts";
import { triggerDev } from "./checks/trigger-dev.ts";

export const MODULES: CheckModule[] = [common, vercel, render, railway, flyIo, googleCloudRun, supabase, cloudflare, hookdeck, inngest, triggerDev];

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

export function preflight(root: string, only?: string[]): { platforms: CheckModule[]; findings: Finding[] } {
  const repo = openRepo(root);
  const platforms = MODULES.filter((m) => m.platform === "common" || (only ? only.includes(m.platform) : m.detect(repo)));
  const findings: Finding[] = [];
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
