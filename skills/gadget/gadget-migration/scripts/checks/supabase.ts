// Checks for apps moving to Supabase. references/platforms/supabase.md explains each one.
import { DOCS, type CheckModule, type Finding, type Repo } from "./types.ts";
import { keyLine, lineAt, parseToml } from "./read-config.ts";

const GUIDE = `${DOCS}/supabase`;

// env example files, which hold the URLs a deployed app is meant to use
const ENV_EXAMPLE = /(^|\/)(\.env(\.[\w-]+)?\.(example|sample|template)|example\.env)$/;

// ---------------------------------------------------------------------------------------------
// SQL helpers. Migrations are read as text: comments are blanked out (keeping line numbers), and
// statements are split on semicolons outside quotes and dollar quotes.

interface Statement {
  file: string;
  // offset of the statement in the file, for line numbers
  start: number;
  text: string;
}

function blankComments(sql: string): string {
  let out = "";
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === c && sql[j + 1] !== c)) j += sql[j] === c ? 2 : 1;
      out += sql.slice(i, j + 1);
      i = j;
    } else if (c === "$" && /^\$[A-Za-z_]*\$/.test(sql.slice(i))) {
      const tag = sql.slice(i).match(/^\$[A-Za-z_]*\$/)![0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end < 0 ? sql.length : end + tag.length;
      out += sql.slice(i, stop);
      i = stop - 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") (out += " "), i++;
      out += sql[i] ?? "";
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end < 0 ? sql.length : end + 2;
      out += sql.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop - 1;
    } else {
      out += c;
    }
  }
  return out;
}

function statements(file: string, sql: string): Statement[] {
  const text = blankComments(sql);
  const out: Statement[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < text.length && !(text[j] === c && text[j + 1] !== c)) j += text[j] === c ? 2 : 1;
      i = j;
    } else if (c === "$" && /^\$[A-Za-z_]*\$/.test(text.slice(i))) {
      const tag = text.slice(i).match(/^\$[A-Za-z_]*\$/)![0];
      const end = text.indexOf(tag, i + tag.length);
      i = end < 0 ? text.length : end + tag.length - 1;
    } else if (c === ";") {
      out.push({ file, start, text: text.slice(start, i) });
      start = i + 1;
    }
  }
  if (text.slice(start).trim()) out.push({ file, start, text: text.slice(start) });
  // move each statement's start past leading whitespace, so its line is the line it begins on
  return out.map((s) => {
    const lead = s.text.length - s.text.trimStart().length;
    return { ...s, start: s.start + lead, text: s.text.trimStart() };
  });
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;
const QUALIFIED = String.raw`${IDENT}(?:\s*\.\s*${IDENT})?`;

// "public"."Session" -> public.Session, audit_log -> public.audit_log, Foo -> public.foo
function tableKey(raw: string): string {
  const parts = raw.split(/\s*\.\s*(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((p) => (p.startsWith('"') ? p.slice(1, -1).replace(/""/g, '"') : p.toLowerCase()));
  return parts.length === 1 ? `public.${parts[0]}` : `${parts[0]}.${parts[1]}`;
}

function list(raw: string): string[] {
  return raw
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const lineOfStatement = (repo: Repo, s: Statement) => lineAt(repo.read(s.file) ?? "", s.start);

// ---------------------------------------------------------------------------------------------

interface Migrations {
  // supabase/migrations first, then Prisma's, each in file name order
  sets: { name: string; files: string[] }[];
  statements: Statement[];
}

function migrations(repo: Repo): Migrations {
  const supabaseFiles = repo.find(/^supabase\/migrations\/[^/]+\.sql$/).sort();
  const prismaFiles = repo.find(/(^|\/)migrations\/[^/]+\/migration\.sql$/).filter((f) => !f.startsWith("supabase/")).sort();
  const sets = [
    { name: "supabase", files: supabaseFiles },
    { name: "prisma", files: prismaFiles },
  ];
  const all: Statement[] = [];
  for (const set of sets) for (const file of set.files) all.push(...statements(file, repo.read(file) ?? ""));
  return { sets, statements: all };
}

function readConfig(repo: Repo): { config: any; findings: Finding[] } {
  const text = repo.read("supabase/config.toml");
  if (text === null) return { config: null, findings: [] };
  try {
    return { config: parseToml(text), findings: [] };
  } catch (error) {
    return {
      config: null,
      findings: [
        {
          id: "supabase/config-unreadable",
          severity: "manual",
          file: "supabase/config.toml",
          message: `The checks couldn't read supabase/config.toml (${(error as Error).message}), so they assume the Data API exposes public.`,
          fix: "Check the [api] section by hand: enabled, schemas, and auto_expose_new_tables.",
        },
      ],
    };
  }
}

interface TableState {
  key: string;
  file: string;
  line: number;
  rls: boolean;
  revokedFrom: Set<string>;
  grantedTo: Set<string>;
}

// Tables the Data API roles can reach: created in an exposed schema, with neither row-level
// security nor a revoke from both anon and authenticated.
function exposureFindings(repo: Repo, m: Migrations, config: any): { findings: Finding[]; tables: Map<string, TableState> } {
  const api = config?.api ?? {};
  const exposed: string[] = Array.isArray(api.schemas) ? api.schemas : ["public", "graphql_public"];
  const autoExpose = api.auto_expose_new_tables !== false;
  const tables = new Map<string, TableState>();
  // "alter default privileges ... revoke ... on tables from anon" covers tables created after it
  const revokeDefaults = (text: string) => text.match(/^alter\s+default\s+privileges\b[\s\S]*?\brevoke\b[\s\S]*?\bon\s+tables\s+from\s+([\s\S]+?)(?:\s+(?:cascade|restrict))?$/i);
  const setRevokes = new Map<string, Set<string>>();
  for (const set of m.sets) {
    const roles = new Set<string>();
    for (const s of m.statements.filter((st) => set.files.includes(st.file))) for (const r of list(revokeDefaults(s.text)?.[1] ?? "")) roles.add(r.toLowerCase());
    setRevokes.set(set.name, roles);
  }
  for (const set of m.sets) {
    const revokedHere = new Set<string>();
    for (const s of m.statements.filter((st) => set.files.includes(st.file))) {
      const text = s.text;
      const create = text.match(new RegExp(String.raw`^create\s+(?:(?:global|local)\s+)?(temp|temporary|unlogged\s+)?\s*table\s+(?:if\s+not\s+exists\s+)?(${QUALIFIED})`, "i"));
      if (create && !/^temp/i.test(create[1] ?? "")) {
        const key = tableKey(create[2]);
        const inherited = new Set<string>(revokedHere);
        // the other tool's migrations usually run first, so their default revokes cover this table too
        for (const [name, roles] of setRevokes) if (name !== set.name) for (const r of roles) inherited.add(r);
        if (!autoExpose) inherited.add("anon").add("authenticated");
        tables.set(key, { key, file: s.file, line: lineOfStatement(repo, s), rls: false, revokedFrom: inherited, grantedTo: new Set() });
        continue;
      }
      const drop = text.match(new RegExp(String.raw`^drop\s+table\s+(?:if\s+exists\s+)?(${QUALIFIED}(?:\s*,\s*${QUALIFIED})*)`, "i"));
      if (drop) for (const t of list(drop[1])) tables.delete(tableKey(t));
      const rename = text.match(new RegExp(String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${QUALIFIED})\s+rename\s+to\s+(${IDENT})`, "i"));
      if (rename) {
        const old = tables.get(tableKey(rename[1]));
        if (old) {
          tables.delete(old.key);
          const key = `${old.key.split(".")[0]}.${tableKey(rename[2]).split(".")[1]}`;
          tables.set(key, { ...old, key });
        }
      }
      const rls = text.match(new RegExp(String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${QUALIFIED})\s+enable\s+row\s+level\s+security`, "i"));
      if (rls) {
        const t = tables.get(tableKey(rls[1]));
        if (t) t.rls = true;
      }
      const revoke = text.match(/^revoke\s+[\s\S]*?\bon\s+(?:table\s+)?([\s\S]+?)\s+from\s+([\s\S]+?)(?:\s+(?:cascade|restrict))?$/i);
      if (revoke) {
        const roles = list(revoke[2]).map((r) => r.toLowerCase());
        const schemaWide = revoke[1].match(/^all\s+tables\s+in\s+schema\s+([\s\S]+)$/i);
        const targets = schemaWide ? [...tables.values()].filter((t) => list(schemaWide[1]).some((sc) => t.key.startsWith(`${tableKey(sc).split(".")[1]}.`))) : list(revoke[1]).map((t) => tables.get(tableKey(t))).filter((t): t is TableState => !!t);
        for (const t of targets) for (const role of roles) t.revokedFrom.add(role), t.grantedTo.delete(role);
      }
      const grant = text.match(/^grant\s+[\s\S]*?\bon\s+(?:table\s+)?([\s\S]+?)\s+to\s+([\s\S]+?)(?:\s+with\s+grant\s+option)?$/i);
      if (grant && !/^all\s+(sequences|functions|routines)\b|^schema\b|^sequence\b|^function\b/i.test(grant[1])) {
        const roles = list(grant[2]).map((r) => r.toLowerCase());
        const schemaWide = grant[1].match(/^all\s+tables\s+in\s+schema\s+([\s\S]+)$/i);
        const targets = schemaWide ? [...tables.values()].filter((t) => list(schemaWide[1]).some((sc) => t.key.startsWith(`${tableKey(sc).split(".")[1]}.`))) : list(grant[1]).map((t) => tables.get(tableKey(t))).filter((t): t is TableState => !!t);
        for (const t of targets) for (const role of roles) if (["anon", "authenticated", "public"].includes(role)) t.grantedTo.add(role), t.revokedFrom.delete(role);
      }
      for (const role of list(revokeDefaults(text)?.[1] ?? "")) revokedHere.add(role.toLowerCase());
    }
  }
  const findings: Finding[] = [];
  if (api.enabled === false) return { findings, tables };
  for (const t of tables.values()) {
    if (!exposed.includes(t.key.split(".")[0])) continue;
    if (t.rls) continue;
    const open = ["anon", "authenticated"].filter((r) => !t.revokedFrom.has(r) || t.grantedTo.has(r) || t.grantedTo.has("public"));
    if (open.length === 0) continue;
    const name = t.key.split(".")[1];
    const session = /^session$/i.test(name) && /accessToken/.test(repo.read(t.file) ?? "");
    findings.push({
      id: "supabase/rls-missing",
      severity: "error",
      file: t.file,
      line: t.line,
      message: session
        ? `The "${name}" table holds every store's Shopify access token, and nothing in the migrations enables row-level security on it or revokes it from ${open.join(" and ")}. On a project that exposes new tables, anyone with the publishable key from your frontend can read the tokens through the Data API.`
        : `${t.key} has no row-level security and isn't revoked from ${open.join(" and ")}, so on a project that exposes new tables, anyone with the publishable key from your frontend can read and delete its rows through the Data API.`,
      error: `curl "https://<project-ref>.supabase.co/rest/v1/${name}?select=*" -H "apikey: sb_publishable_..." returns every row`,
      fix: `Add "alter table ${t.key} enable row level security;" or "revoke all on ${t.key} from anon, authenticated;" in a migration. If nothing calls the Data API, turn it off and set [api] enabled = false in supabase/config.toml so local and branches match.`,
      docs: `${GUIDE}#rewrite-permissions-and-shop-tenancy`,
    });
  }
  return { findings, tables };
}

function policyFindings(repo: Repo, m: Migrations, tables: Map<string, TableState>): Finding[] {
  const findings: Finding[] = [];
  for (const s of m.statements) {
    const policy = s.text.match(new RegExp(String.raw`^create\s+policy\s+(${IDENT})\s+on\s+(${QUALIFIED})([\s\S]*)$`, "i"));
    if (!policy) continue;
    const body = policy[3];
    const head = body.split(/\busing\b|\bwith\s+check\b/i)[0];
    const roles = head.match(/\bto\s+([\s\S]+)$/i)?.[1];
    const table = tables.get(tableKey(policy[2]));
    const line = lineOfStatement(repo, s);
    if (/\buser_metadata\b/.test(body)) {
      findings.push({
        id: "supabase/policy-user-metadata",
        severity: "error",
        file: s.file,
        line,
        message: `Policy ${policy[1]} reads user_metadata, which every signed-in user can change for themselves with supabase.auth.updateUser, so a user can grant themselves rows.`,
        fix: "Read roles and ids from app_metadata, which only your server can change: (select auth.jwt()) -> 'app_metadata' ->> 'gadget_id'.",
        docs: `${GUIDE}#policies-for-the-data-api`,
      });
    }
    const allRoles = !roles || list(roles).every((r) => r.toLowerCase() === "public");
    if (!allRoles) continue;
    // a table revoked from both Data API roles can't be reached through the Data API anyway
    if (table && table.revokedFrom.has("anon") && table.revokedFrom.has("authenticated") && table.grantedTo.size === 0) continue;
    const open = /\busing\s*\(\s*true\s*\)/i.test(body) || (/\bwith\s+check\s*\(\s*true\s*\)/i.test(body) && !/\busing\b/i.test(body));
    findings.push({
      id: "supabase/policy-without-role",
      severity: open ? "error" : "warning",
      file: s.file,
      line,
      message: open
        ? `Policy ${policy[1]} has no "to" clause and allows every row, so it applies to anon too: anyone with the publishable key reads ${policy[2]} through the Data API.`
        : `Policy ${policy[1]} has no "to" clause, so it applies to anon and authenticated as well as your server's role, and the table isn't revoked from them.`,
      fix: `Name the role, as in "create policy ${policy[1]} on ${policy[2]} to app_server using (...)", and revoke the table from anon and authenticated unless the browser reads it.`,
      docs: `${GUIDE}#policies-for-your-server`,
    });
  }
  return findings;
}

function viewFindings(repo: Repo, m: Migrations, tables: Map<string, TableState>): Finding[] {
  const findings: Finding[] = [];
  const rlsTables = [...tables.values()].filter((t) => t.rls).map((t) => t.key.split(".")[1]);
  if (rlsTables.length === 0) return findings;
  const invoker = new Set<string>();
  for (const s of m.statements) {
    const alter = s.text.match(new RegExp(String.raw`^alter\s+view\s+(?:if\s+exists\s+)?(${QUALIFIED})\s+set\s*\(([^)]*)\)`, "i"));
    if (alter && /security_invoker\s*(=\s*(true|on|1|'true'|'on'))?\s*($|,)/i.test(alter[2].trim())) invoker.add(tableKey(alter[1]));
  }
  for (const s of m.statements) {
    const view = s.text.match(new RegExp(String.raw`^create\s+(?:or\s+replace\s+)?(materialized\s+)?(?:recursive\s+)?view\s+(?:if\s+not\s+exists\s+)?(${QUALIFIED})(?:\s*\([^)]*\))?\s*(?:with\s*\(([^)]*)\))?\s*as\b([\s\S]*)$`, "i"));
    if (!view) continue;
    const [, materialized, name, options, body] = view;
    if (!materialized && options && /security_invoker\s*(=\s*(true|on|1|'true'|'on'))?\s*($|,)/i.test(options.trim())) continue;
    if (!materialized && invoker.has(tableKey(name))) continue;
    const reads = rlsTables.filter((t) => new RegExp(String.raw`(^|[^\w$."])"?${t.replace(/[$]/g, "\\$")}"?(?![\w$])`, "i").test(body));
    if (reads.length === 0) continue;
    findings.push({
      id: "supabase/view-security-invoker",
      severity: "error",
      file: s.file,
      line: lineOfStatement(repo, s),
      message: materialized
        ? `Materialized view ${name} reads ${reads.join(", ")}, with row-level security, but it stores rows computed as its owner, so no policy applies when app_server reads it.`
        : `View ${name} reads ${reads.join(", ")}, with row-level security, but a view created by postgres reads its tables as postgres, which has BYPASSRLS, so it returns every store's rows to app_server.`,
      error: "the view returns rows for every store while app.shop_id is set to one",
      fix: materialized
        ? "Use a plain view with security_invoker, or keep shop_id in the materialized view, revoke it from anon and authenticated, and filter by store in every query."
        : `Create it with "create view ${name} with (security_invoker = true) as ...", or run "alter view ${name} set (security_invoker = true)" in a later migration.`,
      docs: `${GUIDE}#policies-for-your-server`,
    });
  }
  return findings;
}

function vectorFindings(repo: Repo, m: Migrations): Finding[] {
  const ext = m.statements.find((s) => /^create\s+extension\s+(?:if\s+not\s+exists\s+)?"?vector"?\s+(?:with\s+)?schema\s+"?extensions"?/i.test(s.text));
  if (!ext) return [];
  const findings: Finding[] = [];
  for (const s of m.statements) {
    const role = s.text.match(new RegExp(String.raw`^create\s+(role|user)\s+(?!mapping\b)(${IDENT})([\s\S]*)$`, "i"));
    if (!role) continue;
    const isLogin = role[1].toLowerCase() === "user" ? !/\bnologin\b/i.test(role[3]) : /\blogin\b/i.test(role[3]) && !/\bnologin\b/i.test(role[3]);
    if (!isLogin) continue;
    const name = role[2].replace(/"/g, "");
    const mentions = (pattern: RegExp) => m.statements.some((st) => pattern.test(st.text));
    const nameRe = name.replace(/[$]/g, "\\$");
    const granted = mentions(new RegExp(String.raw`^grant\s+usage\s+on\s+schema\s+[\w",\s]*\bextensions\b[\w",\s]*\s+to\s+[\w",\s]*\b${nameRe}\b`, "i"));
    const searchPath = mentions(new RegExp(String.raw`^alter\s+(role|user)\s+"?${nameRe}"?\s+(in\s+database\s+\S+\s+)?set\s+search_path\s*(=|to)[^;]*\bextensions\b`, "i"));
    if (granted && searchPath) continue;
    const missing = [!granted && `grant usage on schema extensions to ${name};`, !searchPath && `alter role ${name} set search_path = "$user", public, extensions;`].filter(Boolean);
    findings.push({
      id: "supabase/vector-grant",
      severity: "error",
      file: s.file,
      line: lineOfStatement(repo, s),
      message: `pgvector is in the extensions schema (${ext.file}), and ${name} ${!granted ? "has no usage on that schema" : "doesn't search it"}, so similarity queries fail for your server while migrations, run as postgres, work.`,
      error: !granted && searchPath ? "permission denied for schema extensions" : "operator does not exist: extensions.vector <=> unknown",
      fix: `Add to a migration: ${missing.join(" ")}`,
      docs: `${GUIDE}#map-your-models-to-database-tables`,
    });
  }
  return findings;
}

function cronFindings(repo: Repo, m: Migrations): Finding[] {
  const findings: Finding[] = [];
  const migrationFiles = new Set(m.sets.flatMap((s) => s.files));
  const sqlFiles = repo.find(/\.sql$/).sort();
  const all = sqlFiles.flatMap((f) => statements(f, repo.read(f) ?? ""));
  const schedules = all.filter((s) => /\bcron\s*\.\s*schedule\s*\(/i.test(s.text));
  for (const s of schedules) {
    const line = lineOfStatement(repo, s);
    const name = s.text.match(/\bcron\s*\.\s*schedule\s*\(\s*'([^']+)'\s*,\s*'/i)?.[1] ?? "this job";
    if (migrationFiles.has(s.file)) {
      findings.push({
        id: "supabase/cron-in-migration",
        severity: "warning",
        file: s.file,
        line,
        message: `${name} is scheduled in a migration, so it starts as soon as the migration is applied: in production before the cutover, while Gadget still runs the same job, and on every preview branch and local database.`,
        fix: "Move cron.schedule calls to a SQL file you run per environment with psql at the cutover's \"Move scheduled work\" step. cron.schedule with the same job name updates the job, so the file is safe to run again.",
        docs: `${GUIDE}#cut-over-to-the-new-platform`,
      });
    }
    if (/\bnet\s*\.\s*http_(post|get|delete)\s*\(/i.test(s.text)) {
      findings.push({
        id: "supabase/cron-http",
        severity: "warning",
        file: s.file,
        line,
        message: `${name} calls a URL with pg_net. cron.job_run_details records succeeded as soon as the request is queued, even when it fails, pg_cron never retries it, and the request comes from no fixed or published address.`,
        error: "cron.job_run_details: status succeeded, return_message 1 row; net._http_response: error_msg Could not connect to server",
        fix: "Have the job add a pgmq message, as in select pgmq.send('scheduled', '{\"job\": \"...\"}'), and let your worker on the Node host do the call with retries.",
        docs: `${GUIDE}#replace-scheduled-actions`,
      });
    }
  }
  if (schedules.length > 0 && !all.some((s) => /delete\s+from\s+cron\s*\.\s*job_run_details\b/i.test(s.text))) {
    findings.push({
      id: "supabase/cron-history",
      severity: "warning",
      file: schedules[0].file,
      line: lineOfStatement(repo, schedules[0]),
      message: "pg_cron writes a row to cron.job_run_details for every run and never deletes one, and no SQL file here prunes it.",
      fix: "Schedule a cleanup next to your jobs: select cron.schedule('prune-cron-history', '30 3 * * *', $$ delete from cron.job_run_details where end_time < now() - interval '7 days' $$);",
      docs: `${GUIDE}#replace-scheduled-actions`,
    });
  }
  return findings;
}

// A Supabase database URL: through Supavisor, or a direct connection to db.<project-ref>.supabase.co.
// https://<project-ref>.supabase.co alone is the API, which Auth and Storage use with a database elsewhere.
const DATABASE_URL = /pooler\.supabase\.com|\.supabase\.co:(?:5432|6543)\b|\bdb\.[a-z0-9]+\.supabase\.co\b/;

// Whether the app's database is on Supabase: it has files under supabase/, such as migrations or
// config.toml, a Supabase database URL in an env file, a deploy config, or source, or a script that runs
// supabase db or supabase migration. supabase-js alone can mean Auth or Storage, and then the database
// checks would read migrations meant for another host.
function usesSupabaseDatabase(repo: Repo): boolean {
  if (repo.files.some((f) => f.startsWith("supabase/"))) return true;
  const env = repo.files.filter((f) => /(^|\/)\.env(\.[\w-]+)?$/.test(f));
  if ([...env, ...urlFiles(repo)].some((f) => DATABASE_URL.test(repo.read(f) ?? ""))) return true;
  return [...Object.values(repo.scripts()), ...scriptFiles(repo).map((f) => repo.read(f) ?? "")].some((t) => /\bsupabase\s+(db|migration)\s/.test(t));
}

// CI configs, Makefiles, and shell scripts, where deploy commands live besides package.json.
const scriptFiles = (repo: Repo) => repo.files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$|(^|\/)\.gitlab-ci\.ya?ml$|(^|\/)(bitbucket-pipelines|cloudbuild)\.ya?ml$|^\.circleci\/config\.ya?ml$|(^|\/)Makefile$|\.sh$/.test(f));

// Text files that hold connection URLs: env examples, deploy configs, and source.
function urlFiles(repo: Repo): string[] {
  const config = repo.files.filter((f) => ENV_EXAMPLE.test(f) || /(^|\/)(render\.ya?ml|fly\.toml|app\.json|docker-compose\.ya?ml|compose\.ya?ml|vercel\.json|wrangler\.(toml|jsonc?))$/.test(f));
  return [...new Set([...config, ...repo.sourceFiles()])];
}

function connectionFindings(repo: Repo, tables: Map<string, TableState>): Finding[] {
  const findings: Finding[] = [];
  const deps = repo.dependencies();
  const prisma = Boolean(deps["@prisma/client"] || deps.prisma) && !deps["@prisma/adapter-pg"];
  if (prisma) {
    for (const file of urlFiles(repo)) {
      const text = repo.read(file) ?? "";
      for (const match of text.matchAll(/postgres(?:ql)?:\/\/[^\s"'`]+?:6543(?![\d])[^\s"'`]*/g)) {
        if (/[?&]pgbouncer=true\b/.test(match[0])) continue;
        findings.push({
          id: "supabase/prisma-pgbouncer",
          severity: "error",
          file,
          line: lineAt(text, match.index!),
          message: "This URL goes through Supavisor in transaction mode (port 6543), which doesn't support prepared statements, and Prisma uses them unless the URL says pgbouncer=true.",
          error: 'prepared statement "s1" does not exist',
          fix: "Add ?pgbouncer=true (or &pgbouncer=true) to the URL, and give prisma migrate the direct or session URL with directUrl.",
          docs: `${GUIDE}#connect-to-your-database`,
        });
      }
    }
  }
  // the variable the server connects with: Prisma's url, or DATABASE_URL
  if ([...tables.values()].some((t) => t.rls)) {
    const schemaPath = repo.find(/(^|\/)schema\.prisma$/)[0];
    const schema = schemaPath ? repo.read(schemaPath) ?? "" : "";
    const variable = schema.match(/datasource\s+\w+\s*\{[^}]*?\burl\s*=\s*env\(\s*"([^"]+)"\s*\)/)?.[1] ?? "DATABASE_URL";
    for (const file of repo.files.filter((f) => ENV_EXAMPLE.test(f))) {
      const text = repo.read(file) ?? "";
      const match = text.match(new RegExp(String.raw`^\s*(?:export\s+)?${variable}\s*=\s*["']?postgres(?:ql)?:\/\/(postgres(?:\.[^:@/\s]+)?)(?::[^@\s]*)?@`, "m"));
      if (!match) continue;
      findings.push({
        id: "supabase/server-url-postgres",
        severity: "error",
        file,
        line: lineAt(text, match.index! + match[0].indexOf(variable)),
        message: `${variable} signs in as ${match[1]}. Supabase's postgres role has BYPASSRLS and owns the tables, so every row-level security policy in your migrations is skipped for the server.`,
        error: "select count(*) from audit_log counts every store's rows while app.shop_id is set to one",
        fix: `Sign the server in as your own role, such as app_server.<project-ref> through the pooler or app_server on the direct connection, and keep postgres for migrations only.`,
        docs: `${GUIDE}#policies-for-your-server`,
      });
    }
  }
  return findings;
}

function cliFindings(repo: Repo): Finding[] {
  const findings: Finding[] = [];
  const candidates = [
    ...Object.entries(repo.scripts()).map(([name, command]) => ({ file: "package.json", text: repo.read("package.json") ?? "", command, name })),
    ...scriptFiles(repo).map((f) => ({ file: f, text: repo.read(f) ?? "", command: repo.read(f) ?? "", name: "" })),
  ];
  const seen = new Set<string>();
  for (const { file, text, command } of candidates) {
    for (const match of command.matchAll(/supabase\s+db\s+push\b[^\n&|;]*/g)) {
      if (/--remote\b|--linked\b|--db-url\b/.test(match[0])) continue;
      const index = text.indexOf(match[0]);
      const key = `${file}:${index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        id: "supabase/db-push-local",
        severity: "warning",
        file,
        line: index >= 0 ? lineAt(text, index) : undefined,
        message: "supabase db push without --remote targets the local database on Supabase CLI 3: it changes the local stack and leaves the project unchanged, or fails where no local stack runs, such as in CI.",
        error: "Target: local stack (127.0.0.1:54322)",
        fix: "Run supabase link --project-ref <project-ref> once, then supabase db push --remote.",
        docs: `${GUIDE}#set-up-development-and-deploys`,
      });
    }
  }
  return findings;
}

function codeFindings(repo: Repo): Finding[] {
  const findings: Finding[] = [];
  for (const file of repo.files.filter((f) => /^supabase\/functions\/.+\.(ts|js|tsx|mjs)$/.test(f))) {
    const text = repo.read(file) ?? "";
    const match = text.match(/myshopify\.com\/admin\/api|\/admin\/api\/\d{4}-\d{2}\/graphql\.json|@shopify\/shopify-api|@shopify\/admin-api-client|shopify-app-react-router|shopify-app-remix/);
    if (!match) continue;
    findings.push({
      id: "supabase/edge-function-shopify",
      severity: "warning",
      file,
      line: lineAt(text, match.index!),
      message: "This Edge Function calls Shopify's Admin API. Edge Functions send requests from no fixed or published network, so the call fails once your app's IP allowlist is enforced.",
      error: "403 from Shopify's Admin API",
      fix: "Make Shopify calls from your Node host, whose ASN is on the allowlist, and have the Edge Function add a job for it instead.",
      docs: `${GUIDE}#ip-allowlists`,
    });
  }
  const files = [...repo.find(/\.sql$/), ...repo.sourceFiles()];
  for (const file of files) {
    const text = repo.read(file) ?? "";
    const match = text.match(/delete\s+from\s+storage\s*\.\s*(objects|buckets)\b/i);
    if (!match) continue;
    findings.push({
      id: "supabase/storage-sql-delete",
      severity: "error",
      file,
      line: lineAt(text, match.index!),
      message: "This deletes Storage rows with SQL, which Supabase blocks with a trigger, so the statement fails whether or not it matches a row.",
      error: "Direct deletion from storage tables is not allowed. Use the Storage API instead.",
      fix: "Call supabase.storage.from(bucket).remove([path]) from your server when you delete the record that owns the file.",
      docs: `${GUIDE}#search-files-and-other-services`,
    });
  }
  for (const file of repo.sourceFiles()) {
    const text = repo.read(file) ?? "";
    for (const match of text.matchAll(/\.admin\.createUser\s*\(\s*\{/g)) {
      // the object literal passed to createUser
      let depth = 0;
      let end = match.index! + match[0].length - 1;
      for (; end < text.length; end++) {
        if (text[end] === "{") depth++;
        else if (text[end] === "}" && --depth === 0) break;
      }
      const args = text.slice(match.index!, end);
      if (!/\bpassword_hash\b/.test(args) || /\bemail_confirm\b/.test(args)) continue;
      findings.push({
        id: "supabase/import-email-confirm",
        severity: "warning",
        file,
        line: lineAt(text, match.index!),
        message: "This imports users with a password hash and no email_confirm, so each one is created unconfirmed and can't sign in with their Gadget password.",
        error: "Email not confirmed",
        fix: "Pass email_confirm: user.emailVerified, or true for every user Gadget let sign in without verifying.",
        docs: `${GUIDE}#move-app-users-and-sessions`,
      });
    }
  }
  return findings;
}

export const supabase: CheckModule = {
  platform: "supabase",
  title: "Supabase",
  detect: (repo) =>
    repo.exists("supabase/config.toml") ||
    repo.find(/^supabase\/migrations\//).length > 0 ||
    "@supabase/supabase-js" in repo.dependencies() ||
    repo.files.some((f) => ENV_EXAMPLE.test(f) && /\.supabase\.(co|com)\b/.test(repo.read(f) ?? "")),
  run: (repo) => {
    // Auth and Storage alone: only the checks on Storage and Auth calls apply
    if (!usesSupabaseDatabase(repo)) return codeFindings(repo);
    const { config, findings } = readConfig(repo);
    const m = migrations(repo);
    const { findings: exposure, tables } = exposureFindings(repo, m, config);
    findings.push(...exposure, ...policyFindings(repo, m, tables), ...viewFindings(repo, m, tables), ...vectorFindings(repo, m), ...cronFindings(repo, m));
    findings.push(...connectionFindings(repo, tables), ...cliFindings(repo), ...codeFindings(repo));
    if (config?.api?.enabled !== false) {
      findings.push({
        id: "supabase/data-api-grants",
        severity: "manual",
        file: config ? "supabase/config.toml" : undefined,
        line: config ? keyLine(config.api, "enabled") : undefined,
        message: "Tables created in the dashboard, or before your migrations locked things down, can still be open to the publishable key on the hosted project. The files can't show that.",
        fix: "Run the Data API exposure query from references/platforms/supabase.md against each environment as postgres, and check Advisors > Security Advisor in the dashboard.",
        docs: `${GUIDE}#rewrite-permissions-and-shop-tenancy`,
      });
    }
    return findings;
  },
};
