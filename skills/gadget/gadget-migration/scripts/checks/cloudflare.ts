// Checks for apps moving to Cloudflare. references/platforms/cloudflare.md explains each one.
import { DOCS, type CheckModule, type Finding, type Repo } from "./types.ts";
import { keyLine, lineAt, lineOf, parseJsoncWithLines, parseToml } from "./read-config.ts";
import { expandScripts } from "./common.ts";
import { blocks, calls, closing, mask, skipString, skipTemplate } from "./source-scan.ts";

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
// The database: Postgres through Hyperdrive, D1, or both

interface D1Binding {
  binding: string;
  // the migrations folder, and whether the binding names it or it's Wrangler's default, "migrations"
  dir: string;
  explicit: boolean;
  line?: number;
}

interface Databases {
  // a hyperdrive binding in the Wrangler config, or env.HYPERDRIVE in code
  hyperdrive: boolean;
  // the d1_databases bindings of every environment
  d1: D1Binding[];
}

function databases(repo: Repo, w: Wrangler | null): Databases {
  const d1: D1Binding[] = [];
  for (const scope of w ? scopes(w) : []) {
    (scope.node?.d1_databases ?? []).forEach((d: any, i: number) => {
      if (!d || typeof d !== "object") return;
      const explicit = typeof d.migrations_dir === "string" && d.migrations_dir.trim() !== "";
      const dir = (explicit ? d.migrations_dir.trim() : "migrations").replace(/^\.\//, "").replace(/\/+$/, "");
      d1.push({ binding: String(d.binding ?? ""), dir, explicit, line: w!.line([...scope.path, "d1_databases", i]) });
    });
  }
  const configured = !!w && scopes(w).some((s) => (s.node?.hyperdrive ?? []).length > 0);
  const hyperdrive = configured || repo.sourceFiles().some((f) => /\benv\.HYPERDRIVE\b/.test(mask(repo.read(f) ?? "", false)));
  return { hyperdrive, d1 };
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// SQL with comments and the contents of '...' literals blanked, so indexes and lines stay put
function maskSql(sql: string): string {
  const out = sql.split("");
  const wipe = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  for (let i = 0; i < sql.length; i++) {
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      const stop = end < 0 ? sql.length : end;
      wipe(i, stop);
      i = stop;
    } else if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      const stop = end < 0 ? sql.length : end + 2;
      wipe(i, stop);
      i = stop - 1;
    } else if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
      wipe(i + 1, j);
      i = j;
    }
  }
  return out.join("");
}

// The expressions that reach a D1 database in one file: env.DB for each binding, a variable or parameter
// typed D1Database, and a variable set from env.DB. `bare` is the file with comments and strings blanked.
function d1Receivers(bare: string, bindings: string[]): string | null {
  const names = [...new Set(bindings.filter((b) => /^[A-Za-z_$][\w$]*$/.test(b)))];
  const locals = new Set<string>();
  for (const m of bare.matchAll(/\b([A-Za-z_$][\w$]*)\s*\??\s*:\s*D1Database\b/g)) locals.add(m[1]);
  if (names.length) {
    const fromEnv = new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:[\\w$.]+\\.)?env\\.(?:${names.join("|")})\\b(?!\\s*[.(\\[])`, "g");
    for (const m of bare.matchAll(fromEnv)) locals.add(m[1]);
    // const { DB } = env, or const { DB: db } = context.cloudflare.env
    for (const m of bare.matchAll(/\{([^{}]*)\}\s*=\s*(?:[\w$.]+\.)?env\b(?!\s*\.)/g)) {
      for (const part of m[1].split(",")) {
        const [key, alias] = part.split("=")[0].split(":").map((s) => s.trim());
        if (names.includes(key)) locals.add(alias || key);
      }
    }
  }
  const parts = [...(names.length ? [`\\benv\\.(?:${names.join("|")})\\b`] : []), ...[...locals].map((l) => `(?<![\\w$.])(?:this\\.)?${escapeRegex(l)}\\b`)];
  return parts.length ? `(?:${parts.join("|")})` : null;
}

// The SQL a call passes as its first argument: the string or template literal written there, or the one
// a const of that name holds in the same file. Everything outside the string's text is blanked, and so are
// the SQL's own comments and '...' literals. Returns null when the argument is neither.
function sqlArgument(source: string, code: string, bare: string, open: number, close: number): string | null {
  let start = open + 1;
  while (start < close && /\s/.test(source[start])) start++;
  const literalAt = (i: number): [number, number] | null => {
    if (source[i] === '"' || source[i] === "'") return [i, skipString(source, i)];
    if (source[i] === "`") return [i, skipTemplate(source, i)];
    return null;
  };
  let span = literalAt(start);
  if (!span) {
    const name = /^[A-Za-z_$][\w$]*/.exec(bare.slice(start, close))?.[0];
    const next = name ? bare.slice(start + name.length, close).trimStart()[0] : undefined;
    if (!name || (next && next !== "," && next !== ")")) return null;
    const decl = new RegExp(`\\bconst\\s+${escapeRegex(name)}\\s*(?::\\s*string\\s*)?=\\s*`).exec(bare);
    if (!decl) return null;
    span = literalAt(decl.index + decl[0].length);
    if (!span) return null;
  }
  const chars: string[] = source.split("").map((c) => (c === "\n" ? "\n" : " "));
  // the string's own text: what masking the strings changed, which leaves out ${...} expressions
  for (let i = span[0] + 1; i < span[1]; i++) if (code[i] !== bare[i]) chars[i] = code[i];
  return maskSql(chars.join(""));
}

interface SqlSource {
  file: string;
  // the file's text with everything but SQL blanked, at the file's own indexes
  sql: string;
  // migrations go through wrangler, which prints D1's error without the D1_ERROR prefix
  kind: "migration" | "query";
}

// SQL a D1 database runs: the files in its migrations folder, and the literals passed to prepare() or
// exec() on a D1 binding. Also returns the transaction statements sent through a binding.
function d1Sql(repo: Repo, db: Databases): { sources: SqlSource[]; transactions: Finding[]; receivers: Set<string> } {
  const sources: SqlSource[] = [];
  const transactions: Finding[] = [];
  // files that reach a D1 binding
  const receivers = new Set<string>();
  // the default folder only when nothing else claims it: an app on Hyperdrive too may keep Postgres migrations there
  const dirs = [...new Set(db.d1.filter((d) => d.explicit || !db.hyperdrive).map((d) => d.dir))];
  for (const dir of dirs) {
    for (const file of repo.find(new RegExp(`^${escapeRegex(dir)}/[^/]+\\.sql$`))) {
      sources.push({ file, sql: maskSql(repo.read(file) ?? ""), kind: "migration" });
    }
  }
  const bindings = db.d1.map((d) => d.binding);
  for (const file of repo.sourceFiles()) {
    const source = repo.read(file);
    if (!source) continue;
    const code = mask(source, false);
    const bare = mask(source);
    const receiver = d1Receivers(bare, bindings);
    if (!receiver || !new RegExp(receiver).test(bare)) continue;
    receivers.add(file);
    // one view of the file with the SQL of every call in place
    const view: string[] = source.split("").map((c) => (c === "\n" ? "\n" : " "));
    let found = false;
    // transaction statements: where each is written, and which method sends it
    const statements = new Map<number, { statement: string; method: string }>();
    for (const call of calls(source, `${receiver}\\s*\\.\\s*(?:prepare|exec)`)) {
      const sql = sqlArgument(source, code, bare, call.open, call.close);
      if (!sql) continue;
      found = true;
      for (let i = 0; i < sql.length; i++) if (sql[i] !== " " && sql[i] !== "\n") view[i] = sql[i];
      const begin = statementStart(sql);
      if (begin) statements.set(begin.index, { statement: begin.statement.toUpperCase(), method: /\.\s*exec\s*\($/.test(bare.slice(call.index, call.open + 1)) ? "exec" : "prepare" });
    }
    if (found) sources.push({ file, sql: view.join(""), kind: "query" });
    if (statements.size) {
      const [index, { statement, method }] = [...statements].sort((a, b) => a[0] - b[0])[0];
      const all = [...new Set([...statements.values()].map((s) => s.statement))].join(", ");
      transactions.push({
        id: "cloudflare/d1-transaction",
        severity: "error",
        file,
        line: lineAt(source, index),
        message: `This sends ${statements.size > 1 ? all : statement} through a D1 binding's ${method}(). D1 runs each query as its own transaction and rejects transaction statements, so this fails every time${method === "exec" ? ", reported as D1_EXEC_ERROR" : ""}.`,
        error: "To execute a transaction, please use the state.storage.transaction() or state.storage.transactionSync() APIs instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements.",
        fix: "Send the statements together as db.batch([...]), which D1 runs as one transaction. Code that reads a row and decides what to write in between has to become statements that decide in SQL, such as insert ... on conflict.",
        docs: `${GUIDE}#use-d1`,
      });
    }
  }
  return { sources, transactions, receivers };
}

// A transaction statement that starts the SQL or follows one of its ";"s, with its index.
function statementStart(sql: string): { index: number; statement: string } | null {
  const first = sql.search(/\S/);
  if (first < 0) return null;
  const m = /(?:^|;)\s*(begin|commit|end\s+transaction|rollback|savepoint|release)\b/i.exec(sql.slice(first));
  return m ? { index: first + m.index + m[0].length - m[1].length, statement: m[1].replace(/\s+/g, " ") } : null;
}

// Postgres SQL that SQLite rejects or, for serial, accepts and gets wrong. Each error is what local D1
// returned in Wrangler 4.160.0, after "D1_ERROR: " through a binding and before " at offset <n>: SQLITE_ERROR".
interface SqlRule {
  pattern: RegExp;
  // what the SQL uses, as a noun phrase; group 1, when there is one, is where the finding points
  what: (m: RegExpExecArray) => string;
  error?: (m: RegExpExecArray, kind: SqlSource["kind"]) => string;
  // what happens instead of an error, for SQL that SQLite accepts
  result?: (m: RegExpExecArray) => string;
  fix: string;
  docs: string;
}

const POSTGRES_ONLY: SqlRule[] = [
  {
    pattern: /\b(pg_\w*advisory\w*)\s*\(/i,
    what: (m) => `${m[1]}, a Postgres advisory lock`,
    error: (m) => `no such function: ${m[1]}`,
    fix: "Take a lease from the guide's ShopGate Durable Object instead, named for the job, with a limit of 1.",
    docs: `${GUIDE}#limit-concurrency-per-store`,
  },
  {
    pattern: /\b(set_config|current_setting)\s*\(/i,
    what: (m) => `${m[1]}, which Postgres row-level security reads`,
    error: (m) => `no such function: ${m[1]}`,
    fix: "D1 has no row-level security, so name the store in each query, such as where shop_id = ?, in your data access code.",
    docs: `${GUIDE}#use-d1`,
  },
  {
    pattern: /(?<!:)::(?!:)\s*[A-Za-z_]/,
    what: () => "a Postgres :: cast",
    error: () => 'unrecognized token: ":"',
    fix: "Write cast(value as integer), or leave the cast out.",
    docs: `${GUIDE}#use-d1`,
  },
  {
    pattern: /=\s*any\s*\(/i,
    what: () => "= any(...), which takes a Postgres array",
    error: () => "no such function: any",
    fix: "Write in (?, ?) with one placeholder per value, staying under 100 bound parameters.",
    docs: `${GUIDE}#map-your-models-to-database-tables`,
  },
  {
    pattern: /\bnow\s*\(\s*\)/i,
    what: () => "now()",
    error: (_m, kind) => (kind === "migration" ? 'near "(": syntax error' : "no such function: now"),
    fix: "Bind the time from code, such as new Date().toISOString(), or write a column default as default current_timestamp.",
    docs: `${GUIDE}#use-d1`,
  },
  {
    pattern: /\bilike\b/i,
    what: () => "ilike",
    error: () => 'near "ilike": syntax error',
    fix: "Use like, which SQLite already compares without case for ASCII letters.",
    docs: `${GUIDE}#use-d1`,
  },
  {
    pattern: /@>|<@(?!>)|(?<!<)#>>?/,
    what: (m) => `${m[0]}, a Postgres jsonb operator`,
    error: (m) => `unrecognized token: "${m[0].includes("@") ? "@" : "#"}"`,
    fix: "Read JSON with json_extract(column, '$.key') or column ->> '$.key'.",
    docs: `${GUIDE}#use-d1`,
  },
  {
    pattern: /(?:^|[(,])\s*["`[]?[A-Za-z_]\w*["`\]]?\s+((?:small|big)?serial)\b/im,
    what: (m) => `a ${m[1]} column`,
    result: (m) => `SQLite takes ${m[1]} as a type name and generates no values, so an insert that leaves out the id stores null: insert ... returning id gave { id: null }`,
    fix: "Declare the key as id integer primary key autoincrement. D1 has no setval, so after the first load insert and delete one row at (select max(id) from widget) + 1000000; a plain integer primary key continues from the largest loaded id.",
    docs: `${GUIDE}#use-d1`,
  },
];

function d1Findings(repo: Repo, db: Databases, w: Wrangler | null): Finding[] {
  const findings: Finding[] = [];
  const { sources, transactions, receivers } = d1Sql(repo, db);
  findings.push(...transactions);
  const prefix = (kind: SqlSource["kind"]) => (kind === "query" ? "D1_ERROR: " : "");
  const where = (kind: SqlSource["kind"]) => (kind === "migration" ? "This D1 migration uses" : "A query sent to D1 here uses");

  for (const { file, sql, kind } of sources) {
    for (const rule of POSTGRES_ONLY) {
      const matches = [...sql.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags + "g"))] as RegExpExecArray[];
      if (!matches.length) continue;
      const m = matches[0];
      const at = m[1] !== undefined ? m.index! + m[0].lastIndexOf(m[1]) : m.index! + m[0].search(/\S/);
      const more = matches.length > 1 ? ` This file has ${matches.length} of them.` : "";
      findings.push({
        id: "cloudflare/d1-postgres-sql",
        severity: "error",
        file,
        line: lineAt(sql, at),
        message: `${where(kind)} ${rule.what(m)}. ${rule.result ? `${rule.result(m)}.` : "D1 is SQLite and rejects it."}${more}`,
        error: rule.error ? `${prefix(kind)}${rule.error(m, kind)}` : undefined,
        fix: rule.fix,
        docs: rule.docs,
      });
    }

    // pgvector types and operators
    const vector = /(?:^|[(,])\s*["`[]?[A-Za-z_]\w*["`\]]?\s+(vector\s*\(\s*\d+\s*\))/im.exec(sql) ?? /<=>|<->|<#>/.exec(sql);
    if (vector) {
      const column = vector[1] !== undefined;
      findings.push({
        id: "cloudflare/d1-vector",
        severity: "error",
        file,
        line: lineAt(sql, vector.index! + (column ? vector[0].lastIndexOf(vector[1]) : 0)),
        message: column
          ? `${kind === "migration" ? "This D1 migration declares" : "A statement sent to D1 here declares"} a ${vector[1].replace(/\s+/g, "")} column. SQLite accepts it as a type name and stores the value as text, and it has no vector operators, so a similarity search such as order by embedding <=> ? fails.`
          : `${where(kind)} the pgvector operator ${vector[0]}, which SQLite doesn't have.`,
        // a column's error comes from the query that searches it, through the binding
        error: `${column ? "D1_ERROR: " : prefix(kind)}${vector[0].includes("#") ? 'unrecognized token: "#"' : 'near ">": syntax error'}`,
        fix: "Store embeddings in Vectorize, keyed by the record's id, and query it for the nearest ones, or keep this model in Postgres with pgvector.",
        docs: `${GUIDE}#use-d1`,
      });
    }

    // tables wider than D1's 100 columns
    if (kind === "migration") {
      for (const m of sql.matchAll(/\bcreate\s+(?:temp(?:orary)?\s+)?table\s+(?:if\s+not\s+exists\s+)?([\w."`[\]]+)\s*\(/gi)) {
        const open = m.index! + m[0].length - 1;
        const close = closing(sql, open);
        if (close < 0) continue;
        const entries: string[] = [];
        let depth = 0;
        let from = open + 1;
        for (let i = open + 1; i <= close; i++) {
          const c = sql[i];
          if (c === "(") depth++;
          else if (c === ")" && i < close) depth--;
          if ((c === "," && depth === 0) || i === close) {
            entries.push(sql.slice(from, i).trim());
            from = i + 1;
          }
        }
        const columns = entries.filter((e) => e && !/^(constraint|primary\s+key|foreign\s+key|unique|check)\b/i.test(e)).length;
        if (columns > 100) findings.push(wideTable(file, lineAt(sql, m.index!), m[1].replace(/["`[\]]/g, ""), columns));
      }
    }
  }

  // Prisma on D1: a sqlite schema in an app with a D1 binding
  const schemaPath = repo.find(/(^|\/)schema\.prisma$/)[0];
  // comments blanked, so a note about Unsupported("vector(1536)") isn't a field
  const schema = schemaPath ? (repo.read(schemaPath) ?? "").replace(/\/\/.*$/gm, (c) => " ".repeat(c.length)) : "";
  if (schemaPath && /datasource\s+\w+\s*\{[^}]*provider\s*=\s*"sqlite"/.test(schema)) {
    const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)];
    const names = new Set(models.map((m) => m[1]));
    for (const m of models) {
      const open = m.index! + m[0].length - 1;
      const close = schema.indexOf("\n}", open);
      const body = schema.slice(open + 1, close < 0 ? schema.length : close);
      let columns = 0;
      for (const row of body.split("\n")) {
        const field = /^\s*([A-Za-z_]\w*)\s+([A-Za-z_]\w*)/.exec(row);
        if (field && !names.has(field[2])) columns++;
      }
      const table = /@@map\(\s*"([^"]+)"/.exec(body)?.[1] ?? m[1];
      if (columns > 100) findings.push(wideTable(schemaPath, lineAt(schema, m.index!), table, columns, `model ${m[1]}`));
    }
    const vector = /Unsupported\(\s*"vector[^"]*"\s*\)/.exec(schema);
    if (vector) {
      findings.push({
        id: "cloudflare/d1-vector",
        severity: "error",
        file: schemaPath,
        line: lineAt(schema, vector.index!),
        message: `This Prisma schema for D1 declares ${vector[0]}. SQLite accepts it as a type name and stores the value as text, and it has no vector operators, so a similarity search fails.`,
        error: 'D1_ERROR: near ">": syntax error',
        fix: "Store embeddings in Vectorize, keyed by the record's id, and query it for the nearest ones, or keep this model in Postgres with pgvector.",
        docs: `${GUIDE}#use-d1`,
      });
    }
  }

  // multi-row inserts with one "(?, ?, ?)" per row and nothing that splits the rows
  for (const file of receivers) {
    const source = repo.read(file) ?? "";
    const code = mask(source, false);
    const bare = mask(source);
    const spans = blocks(bare);
    for (const m of code.matchAll(/(=>\s*|\.fill\s*\(\s*)(["'`])(\(\s*\?(?:\s*,\s*\?)*\s*\))\2/g)) {
      const perRow = (m[3].match(/\?/g) ?? []).length;
      const at = m.index! + m[1].length;
      // the outermost block around it: the function, or the class for a method
      const enclosing = spans.filter(([s, e]) => s <= at && at <= e).sort((a, b) => a[0] - b[0])[0];
      const scope = enclosing ? bare.slice(enclosing[0], enclosing[1] + 1) : bare;
      if (/\.slice\s*\(|\.splice\s*\(|chunk|for\s*\([^;)]*;[^;)]*;[^)]*\+=/i.test(scope)) continue;
      const rows = Math.floor(100 / perRow);
      findings.push({
        id: "cloudflare/d1-bound-parameters",
        severity: "warning",
        file,
        line: lineAt(source, at),
        message: `This builds one ${m[3]} per row, ${perRow} bound parameter${perRow === 1 ? "" : "s"} each, and nothing in the function splits the rows. D1 allows 100 bound parameters per query, so an insert of more than ${rows} rows fails, which depends on how many rows a caller passes.`,
        error: "D1_ERROR: too many SQL variables",
        fix: `Insert at most ${rows} rows per statement, as the insertRows helper in ${REF} does.`,
        docs: `${GUIDE}#use-d1`,
      });
    }
  }

  // the 10GB a database holds, for an app whose Shopify models live in D1
  const deps = repo.dependencies();
  if (Object.keys(deps).some((d) => d.startsWith("@shopify/shopify-app") || d === "@shopify/shopify-api")) {
    const bindings = [...new Set(db.d1.map((d) => d.binding))].join(", ");
    findings.push({
      id: "cloudflare/d1-size",
      severity: "manual",
      file: w?.file,
      line: db.d1[0].line,
      message: `This Shopify app keeps its data in D1 (${bindings}). A D1 database holds at most 10GB, the highest limit Cloudflare lists, and it can't be raised: 2.4 million records at 2KB each take 4.8GB before their indexes.`,
      fix: "Estimate each model's size from its record count in Gadget, and after loading run npx wrangler d1 info <database> --env production for the database's size. If the data nears a few gigabytes, give each store its own database or keep the largest models in Postgres through Hyperdrive. Cloudflare's D1 limits page lists your account's figure: https://developers.cloudflare.com/d1/platform/limits/",
      docs: `${GUIDE}#use-d1`,
    });
  }
  return findings;
}

function wideTable(file: string, line: number, table: string, columns: number, what = table): Finding {
  return {
    id: "cloudflare/d1-columns",
    severity: "error",
    file,
    line,
    message: `${what} has ${columns} columns, and D1 allows 100 per table, so creating ${table} fails. Gadget's Shopify models, such as shopifyOrder, can have more than 200 stored fields.`,
    error: `too many columns on ${table}: SQLITE_ERROR`,
    fix: "Keep the fields your app reads as columns and store the rest in one JSON column that queries read with json_extract, or keep this model in Postgres through Hyperdrive.",
    docs: `${GUIDE}#use-d1`,
  };
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
  // a binding the generated Env would mark optional, for the error text: the database's, when an environment has one
  const envBinding = (w ? scopes(w).slice(1) : []).flatMap((s) => [...(s.node?.hyperdrive ?? []), ...(s.node?.d1_databases ?? [])]).map((b: any) => b?.binding).find((b) => typeof b === "string") ?? "HYPERDRIVE";
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
          error: `error TS18048: 'env.${envBinding}' is possibly 'undefined'.`,
          fix: "Run wrangler types --env production --strict-vars=false.",
          docs: `${GUIDE}#run-your-app-locally`,
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
          docs: `${GUIDE}#run-your-app-locally`,
        });
      }
    }
  }
  return findings;
}

// The Postgres checks below need no gate on Hyperdrive: each looks for pg, postgres, or Shopify's
// PostgreSQL session storage, which a D1 app doesn't import, and each fails the same way without Hyperdrive.
function codeFindings(repo: Repo, elsewhere: string | null, db: Databases): Finding[] {
  const findings: Finding[] = [];
  const d1Only = db.d1.length > 0 && !db.hyperdrive;
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
        fix: d1Only
          ? "Create a Prisma client per request with @prisma/adapter-d1 on the D1 binding, as Prisma's Cloudflare guide shows."
          : "Use node-postgres through Hyperdrive with a client opened per request, or create a Prisma client per request with @prisma/adapter-pg as Prisma's Cloudflare guide shows.",
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
        fix: d1Only ? "Keep sessions in a D1 table, with one statement per SessionStorage method on the binding." : "Keep sessions in Postgres, as in the guide's workerSessionStorage.",
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
      docs: `${GUIDE}#run-your-app-locally`,
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
  // Prisma on D1 keeps provider = "sqlite", which common/prisma-sqlite reports as the template's leftover.
  suppresses: (repo) => {
    const read = readWrangler(repo);
    const w = read && !("error" in read) ? read : null;
    const db = databases(repo, w);
    const prisma = db.d1.length > 0 && !db.hyperdrive ? ["common/prisma-sqlite"] : [];
    if (processHost(repo, w)) return prisma;
    return ["common/migrate-on-start", "common/cron-script-exit", "common/worker-sigterm", ...prisma];
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
    const db = databases(repo, config);
    findings.push(...scriptFindings(repo, config), ...codeFindings(repo, processHost(repo, config), db));
    if (db.d1.length) findings.push(...d1Findings(repo, db, config));
    return findings;
  },
};
