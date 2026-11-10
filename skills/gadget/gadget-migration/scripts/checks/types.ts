// Shared types for scripts/preflight.ts and its check modules.

// error: the app fails or loses data as written. warning: it works but hits a pitfall under
// some condition the script can't see. manual: something only a dashboard, CLI, or database
// query can show, so the script says what to run instead of passing it.
export type Severity = "error" | "warning" | "manual";

export interface Finding {
  // "<module>/<short-name>", such as "render/keyvalue-eviction"
  id: string;
  severity: Severity;
  // path relative to the scanned directory, and a 1-based line when the script found one
  file?: string;
  line?: number;
  // what is wrong, in one sentence
  message: string;
  // the exact error text, log line, or broken value the user will see, when there is one
  error?: string;
  // what to change, in one or two sentences
  fix: string;
  // the docs guide section that explains why
  docs?: string;
}

export interface Repo {
  root: string;
  // every file under root, relative, with forward slashes, skipping node_modules, build output, and .git
  files: string[];
  exists(path: string): boolean;
  // the file's text, or null when it doesn't exist or isn't readable
  read(path: string): string | null;
  // files whose relative path matches the pattern
  find(pattern: RegExp): string[];
  // source files the app runs: .ts, .tsx, .js, .jsx, .mjs, .cjs outside tests and fixtures
  sourceFiles(): string[];
  // dependencies and devDependencies from the root package.json
  dependencies(): Record<string, string>;
  // scripts from the root package.json
  scripts(): Record<string, string>;
}

export interface CheckModule {
  // the docs route and reference file name, such as "render" or "fly-io"; "common" runs for every app
  platform: string;
  // a short name for reports, such as "Render"
  title: string;
  // whether the app looks like it uses this platform or service
  detect(repo: Repo): boolean;
  run(repo: Repo): Finding[];
}

export const DOCS = "https://docs.gadget.dev/guides/moving-to-another-platform";
