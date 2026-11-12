// Run with: node --test "tests/**/*.test.ts"
// The Google Cloud checks in scripts/checks/google-cloud.ts, on the fixtures in
// fixtures/preflight/google-cloud-*, and on the complete examples in references/platforms/google-cloud.md,
// which must pass their own checks.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { preflight } from "../../skills/gadget/gadget-migration/scripts/preflight.ts";
import { platformBlocks } from "./platform-blocks.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/preflight/${name}`, import.meta.url));
const where = (findings: { id: string; file?: string; line?: number }[]) => findings.map((f) => `${f.id} ${f.file ?? ""}${f.line ? `:${f.line}` : ""}`.trim()).sort();
const own = (findings: { id: string }[]) => findings.filter((f) => f.id.startsWith("google-cloud/"));

function withApp(files: Record<string, string>, test: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "google-cloud-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    test(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const shopifyServer = 'import { shopifyApp } from "@shopify/shopify-app-react-router/server";\nexport default shopifyApp({ apiKey: process.env.SHOPIFY_API_KEY, apiSecretKey: process.env.SHOPIFY_API_SECRET || "", appUrl: process.env.SHOPIFY_APP_URL || "" });\n';

describe("Google Cloud checks", () => {
  it("finds each pitfall in the bad fixture, at its line", () => {
    const { findings } = preflight(fixture("google-cloud-bad"), ["google-cloud"]);
    assert.deepEqual(where(own(findings)), [
      "google-cloud/delete-queue app/tasks.server.ts:30",
      "google-cloud/iam-roles app/services/files.server.ts:6",
      "google-cloud/iam-roles app/tasks.server.ts:16",
      "google-cloud/iam-roles app/tasks.server.ts:24",
      "google-cloud/iam-roles scripts/deploy.sh:12",
      "google-cloud/iam-roles scripts/deploy.sh:21",
      "google-cloud/iam-roles scripts/deploy.sh:21",
      "google-cloud/instance-limits scripts/deploy.sh:17",
      "google-cloud/migrate-before-deploy scripts/deploy.sh:9",
      "google-cloud/migrate-on-start start.sh:3",
      "google-cloud/owner-skips-rls scripts/deploy.sh:9",
      "google-cloud/prisma-generate Dockerfile:9",
      "google-cloud/pubsub-expiration scripts/deploy.sh:21",
      "google-cloud/secret-latest scripts/deploy.sh:12",
      "google-cloud/secret-latest scripts/deploy.sh:17",
      "google-cloud/secret-latest scripts/deploy.sh:9",
      "google-cloud/shopify-env-missing scripts/deploy.sh:12",
      "google-cloud/shopify-env-missing scripts/deploy.sh:17",
      "google-cloud/sql-user-create scripts/gcp-iam.sh:9",
      "google-cloud/task-route-public app/routes/tasks.webhook.tsx:4",
      "google-cloud/timeout-deadline scripts/deploy.sh:12",
    ]);
    const byId = (id: string) => own(findings).filter((f) => f.id === id);
    assert.equal(byId("google-cloud/shopify-env-missing")[0].severity, "error");
    assert.equal(byId("google-cloud/shopify-env-missing")[0].error, "Detected an empty appUrl configuration");
    assert.match(byId("google-cloud/shopify-env-missing")[0].message, /SHOPIFY_APP_URL, SHOPIFY_API_SECRET/);
    assert.equal(byId("google-cloud/migrate-before-deploy")[0].severity, "error");
    assert.equal(byId("google-cloud/instance-limits")[0].severity, "manual");
    assert.equal(byId("google-cloud/owner-skips-rls")[0].severity, "error");
    assert.match(byId("google-cloud/owner-skips-rls")[0].message, /secret database-url, and my-app-worker reads DATABASE_URL from the same secret.*policies on audit_log/);
    assert.equal(byId("google-cloud/sql-user-create")[0].severity, "warning");
    assert.deepEqual(byId("google-cloud/iam-roles").map((f) => f.message.match(/roles\/[\w.]+/)![0]).sort(), [
      "roles/cloudsql.client",
      "roles/cloudtasks.queueAdmin",
      "roles/iam.serviceAccountTokenCreator",
      "roles/iam.serviceAccountUser",
      "roles/pubsub.publisher",
      "roles/pubsub.subscriber",
    ]);
    for (const f of own(findings)) {
      assert.ok(f.fix.endsWith("."), `${f.id} fix ends with a period`);
      assert.match(f.docs ?? "", /^https:\/\/docs\.gadget\.dev\/guides\/moving-to-another-platform\/google-cloud#/);
    }
  });

  it("finds nothing in the good fixture, which fixes each one", () => {
    assert.deepEqual(where(own(preflight(fixture("google-cloud-good"), ["google-cloud"]).findings)), []);
  });

  it("is detected from @google-cloud/tasks or a gcloud run deploy script", () => {
    assert.ok(preflight(fixture("google-cloud-good")).platforms.some((p) => p.platform === "google-cloud"));
    withApp({ "deploy.sh": "gcloud run deploy my-app-web --image=x\n" }, (dir) => assert.ok(preflight(dir).platforms.some((p) => p.platform === "google-cloud")));
  });

  it("lists the roles to check by hand when the repo has no IAM setup", () => {
    withApp({ "app/tasks.server.ts": "client.createQueue({});\n" }, (dir) => {
      const found = own(preflight(dir, ["google-cloud"]).findings);
      assert.deepEqual(where(found), ["google-cloud/iam-roles"]);
      assert.equal(found[0].severity, "manual");
      assert.match(found[0].message, /roles\/cloudtasks\.queueAdmin/);
    });
  });

  it("reads gcloud args in cloudbuild.yaml, and reports a dispatch deadline shorter than the timeout as two copies", () => {
    withApp(
      {
        "cloudbuild.yaml": "steps:\n  - name: gcr.io/google.com/cloudsdktool/cloud-sdk\n    entrypoint: gcloud\n    args: ['run', 'deploy', 'my-app-worker', '--image=x', '--no-allow-unauthenticated', '--timeout=30m']\n",
        "app/tasks.server.ts": "await client.createTask({ parent, task: { dispatchDeadline: { seconds: 15 * 60 } } });\n",
      },
      (dir) => {
        const found = own(preflight(dir, ["google-cloud"]).findings).filter((f) => f.id === "google-cloud/timeout-deadline");
        assert.deepEqual(where(found), ["google-cloud/timeout-deadline app/tasks.server.ts:1"]);
        assert.equal(found[0].severity, "error");
        assert.match(found[0].message, /15 minutes.*30 minutes/);
      }
    );
  });

  it("reads a dispatch deadline from a constant in the same file, and asks for a check by hand when it can't", () => {
    const deploy = "gcloud run deploy my-app-worker --image=x --no-allow-unauthenticated --timeout=15m\n";
    const tasks = "const DISPATCH_DEADLINE_SECONDS = 15 * 60;\nawait client.createTask({ parent, task: { dispatchDeadline: { seconds: DISPATCH_DEADLINE_SECONDS } } });\n";
    withApp({ "scripts/deploy.sh": deploy, "app/tasks.server.ts": tasks }, (dir) => {
      assert.deepEqual(own(preflight(dir, ["google-cloud"]).findings).filter((f) => f.id === "google-cloud/timeout-deadline"), []);
    });
    const unknown = "await client.createTask({ parent, task: { dispatchDeadline: { seconds: config.deadlineSeconds } } });\n";
    withApp({ "scripts/deploy.sh": deploy, "app/tasks.server.ts": unknown }, (dir) => {
      const found = own(preflight(dir, ["google-cloud"]).findings).filter((f) => f.id === "google-cloud/timeout-deadline");
      assert.deepEqual(where(found), ["google-cloud/timeout-deadline app/tasks.server.ts:1"]);
      assert.equal(found[0].severity, "manual");
      assert.match(found[0].message, /config\.deadlineSeconds/);
    });
  });

  it("warns, and says to lower --timeout, when the deadline is already Cloud Tasks' 30-minute maximum", () => {
    const deploy = "gcloud run deploy my-app-worker --image=x --no-allow-unauthenticated --timeout=60m\n";
    withApp({ "scripts/deploy.sh": deploy, "app/tasks.server.ts": "await client.createTask({ parent, task: { dispatchDeadline: { seconds: 30 * 60 } } });\n" }, (dir) => {
      const found = own(preflight(dir, ["google-cloud"]).findings).filter((f) => f.id === "google-cloud/timeout-deadline");
      assert.deepEqual(where(found), ["google-cloud/timeout-deadline scripts/deploy.sh:1"]);
      assert.equal(found[0].severity, "warning");
      assert.match(found[0].fix, /--timeout to 30m/);
    });
  });

  it("counts a prisma generate after COPY prisma ./prisma, before COPY . .", () => {
    const dockerfile = 'FROM node:22-alpine\nWORKDIR /app\nCOPY package.json package-lock.json* ./\nCOPY prisma ./prisma\nRUN npm ci --omit=dev && npx prisma generate && npm cache clean --force\nCOPY . .\nRUN npm run build\nCMD ["npm", "run", "start"]\n';
    const pkg = JSON.stringify({ scripts: { build: "react-router build", start: "react-router-serve ./build/server/index.js" }, dependencies: { "@google-cloud/tasks": "7.3.1", "@prisma/client": "6.19.3", prisma: "6.19.3" } });
    withApp({ Dockerfile: dockerfile, "package.json": pkg, "prisma/schema.prisma": "" }, (dir) => {
      assert.deepEqual(own(preflight(dir, ["google-cloud"]).findings).filter((f) => f.id === "google-cloud/prisma-generate"), []);
    });
  });

  it("checks every env file a path such as ${ENV}.env.yaml can name, and skips lists it can't read", () => {
    const deploy = 'ENV="${1:?usage}"\nSECRETS="SHOPIFY_API_SECRET=shopify-api-secret:1"\ngcloud run deploy my-app-worker --image=x --env-vars-file="${ENV}.env.yaml" --set-secrets="$SECRETS"\ngcloud run deploy my-app-web --image=x --env-vars-file="${ENV}.env.yaml" --set-secrets="$UNKNOWN"\n';
    withApp(
      {
        "app/shopify.server.ts": shopifyServer,
        "scripts/deploy.sh": deploy,
        "production.env.yaml": "SHOPIFY_APP_URL: https://app.example.com\nSHOPIFY_API_KEY: production-client-id\n",
        "staging.env.yaml": "SHOPIFY_APP_URL: https://my-app-web-987654321.us-central1.run.app\n",
      },
      (dir) => {
        const found = own(preflight(dir, ["google-cloud"]).findings).filter((f) => f.id === "google-cloud/shopify-env-missing");
        // only the worker: the web command's secrets come from a variable the script never sets
        assert.deepEqual(where(found), ["google-cloud/shopify-env-missing scripts/deploy.sh:3"]);
        assert.match(found[0].message, /SHOPIFY_API_KEY \(not in staging\.env\.yaml/);
        assert.equal(found[0].error, "Missing values for: apiKey");
      }
    );
  });

  it("skips row-level security that the owner can't skip, and IAM database users", () => {
    const rls = 'ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;\n';
    const deploy = 'S="DATABASE_URL=database-url:1"\ngcloud run jobs deploy my-app-migrate --image=x --command=npx --args=prisma,migrate,deploy --set-secrets="$S" --execute-now --wait\ngcloud run deploy my-app-web --image=x --set-secrets="$S"\ngcloud sql users create my-app-web@my-app-production.iam --instance=my-app-db --type=cloud_iam_service_account\n';
    const ids = (files: Record<string, string>) => {
      let out: string[] = [];
      withApp(files, (dir) => (out = where(own(preflight(dir, ["google-cloud"]).findings).filter((f) => /owner-skips-rls|sql-user-create/.test(f.id)))));
      return out;
    };
    assert.deepEqual(ids({ "scripts/deploy.sh": deploy, "migrations/1.sql": rls }), ["google-cloud/owner-skips-rls scripts/deploy.sh:2"]);
    // forced for the owner too, or only in a comment
    assert.deepEqual(ids({ "scripts/deploy.sh": deploy, "migrations/1.sql": `${rls}ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;\n` }), []);
    assert.deepEqual(ids({ "scripts/deploy.sh": deploy, "migrations/1.sql": `-- ${rls}` }), []);
    // Prisma Migrate connects with directUrl, which reads another secret here
    const schema = 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n  directUrl = env("DIRECT_DATABASE_URL")\n}\n';
    const direct = deploy.replace("--set-secrets=\"$S\" --execute-now", '--set-secrets="$S,DIRECT_DATABASE_URL=migrate-database-url:1" --execute-now');
    assert.deepEqual(ids({ "scripts/deploy.sh": direct, "migrations/1.sql": rls, "prisma/schema.prisma": schema }), []);
  });

  it("passes the complete examples in google-cloud.md", () => {
    const files: Record<string, string> = {};
    for (const b of platformBlocks("google-cloud.md")) files[b.path] = b.code;
    // row-level security, which the example's two secrets keep in force for the services
    files["prisma/migrations/2_shop_isolation/migration.sql"] = 'ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;\n';
    files["app/shopify.server.ts"] = shopifyServer;
    files["package.json"] = JSON.stringify({ dependencies: { "@google-cloud/tasks": "7.3.1", "@google-cloud/storage": "8.4.0", "@prisma/client": "6.19.3", prisma: "6.19.3" } });
    withApp(files, (dir) => assert.deepEqual(where(own(preflight(dir, ["google-cloud"]).findings)), []));
  });
});

describe("google-cloud/migrate-shared-account", () => {
  const deploy = (migrateAccount: string) =>
    [
      "set -euo pipefail",
      'PROJECT="my-app-production"',
      `gcloud run jobs deploy my-app-migrate --region=us-central1 --image=img --command=npx --args=prisma,migrate,deploy --service-account="${migrateAccount}@\${PROJECT}.iam.gserviceaccount.com" --set-secrets=DATABASE_URL=migrate-database-url:1 --execute-now --wait`,
      'gcloud run deploy my-app-worker --region=us-central1 --image=img --service-account="my-app-worker@${PROJECT}.iam.gserviceaccount.com" --set-secrets=DATABASE_URL=database-url:1',
    ].join("\n") + "\n";
  const shared = (dir: string) => preflight(dir, ["google-cloud"]).findings.filter((f) => f.id === "google-cloud/migrate-shared-account");

  it("warns when the migration job runs as a service's account", () => {
    withApp({ "scripts/deploy.sh": deploy("my-app-worker") }, (dir) => {
      const found = shared(dir);
      assert.deepEqual(where(found), ["google-cloud/migrate-shared-account scripts/deploy.sh:3"]);
      assert.equal(found[0].severity, "warning");
      assert.match(found[0].message, /my-app-worker@my-app-production\.iam\.gserviceaccount\.com/);
    });
  });

  it("says nothing when the migration job has its own account", () => {
    withApp({ "scripts/deploy.sh": deploy("my-app-migrate") }, (dir) => assert.deepEqual(shared(dir), []));
  });

  it("finds nothing in the reference's deploy script, which gives the job my-app-migrate", () => {
    const script = platformBlocks("google-cloud.md").find((b) => b.path === "scripts/deploy.sh")!.code;
    assert.match(script, /--service-account="my-app-migrate@/);
    withApp({ "scripts/deploy.sh": script }, (dir) => assert.deepEqual(shared(dir), []));
  });
});

describe("google-cloud/memorystore-eviction", () => {
  const pkg = (deps: Record<string, string>) => JSON.stringify({ name: "my-app", dependencies: deps });
  const app = (lines: string[], deps: Record<string, string> = { bullmq: "^5.58.0", "@google-cloud/tasks": "^6.2.0" }) => ({
    "package.json": pkg(deps),
    "scripts/gcp-infra.sh": ["set -euo pipefail", ...lines].join("\n") + "\n",
  });
  const eviction = (dir: string) => preflight(dir, ["google-cloud"]).findings.filter((f) => f.id === "google-cloud/memorystore-eviction");

  it("fails an instance created with Memorystore's default policy", () => {
    withApp(app(["gcloud redis instances create my-app-queue --region=us-central1 --size=1"]), (dir) => {
      const found = eviction(dir);
      assert.deepEqual(where(found), ["google-cloud/memorystore-eviction scripts/gcp-infra.sh:2"]);
      assert.equal(found[0].severity, "error");
      assert.match(found[0].message, /^This creates Memorystore instance my-app-queue without a maxmemory-policy, so it gets Memorystore's default, volatile-lru\./);
    });
  });

  it("names a policy that still evicts", () => {
    withApp(app(["gcloud redis instances create my-app-queue --region=us-central1 --size=1 --redis-config=maxmemory-policy=allkeys-lru"]), (dir) =>
      assert.match(eviction(dir)[0].message, /with maxmemory-policy allkeys-lru\./)
    );
  });

  it("says nothing for noeviction, set at creation among other settings or by a later update", () => {
    withApp(app(["gcloud redis instances create my-app-queue --region=us-central1 --size=1 --redis-config=notify-keyspace-events=Ex,maxmemory-policy=noeviction"]), (dir) =>
      assert.deepEqual(eviction(dir), [])
    );
    withApp(
      app([
        "gcloud redis instances create my-app-queue --region=us-central1 --size=1",
        "gcloud redis instances update my-app-queue --region=us-central1 --update-redis-config=maxmemory-policy=noeviction",
      ]),
      (dir) => assert.deepEqual(eviction(dir), [])
    );
  });

  it("says nothing when the app doesn't use BullMQ", () => {
    withApp(app(["gcloud redis instances create my-app-cache --region=us-central1 --size=1"], { "@google-cloud/tasks": "^6.2.0" }), (dir) =>
      assert.deepEqual(eviction(dir), [])
    );
  });
});

describe("Managed Connection Pooling checks", () => {
  const pkg = (deps: Record<string, string> = {}) => JSON.stringify({ name: "my-app", dependencies: { "@google-cloud/tasks": "^6.2.0", ...deps } });
  const infra = (pooling: boolean) => ["set -euo pipefail", `gcloud sql instances create my-app-db --database-version=POSTGRES_18 --region=us-central1${pooling ? " --enable-connection-pooling" : ""}`].join("\n") + "\n";
  const deploy = (opts: { gen2?: boolean; direct?: boolean } = {}) =>
    [
      "set -euo pipefail",
      opts.direct
        ? "gcloud run jobs deploy my-app-migrate --region=us-central1 --image=img --command=npx --args=prisma,migrate,deploy --network=default --subnet=default --set-secrets=DATABASE_URL=migrate-database-url:2 --execute-now --wait"
        : "gcloud run jobs deploy my-app-migrate --region=us-central1 --image=img --command=npx --args=prisma,migrate,deploy --set-cloudsql-instances=p:us-central1:my-app-db --set-secrets=DATABASE_URL=migrate-database-url:1 --execute-now --wait",
      `gcloud run deploy my-app-web --region=us-central1 --image=img --add-cloudsql-instances=p:us-central1:my-app-db${opts.gen2 ? " --execution-environment=gen2" : ""}`,
    ].join("\n") + "\n";
  const ids = (files: Record<string, string>, id: string) => {
    let out: string[] = [];
    withApp(files, (dir) => (out = where(preflight(dir, ["google-cloud"]).findings.filter((f) => f.id === id))));
    return out;
  };

  it("warns about first-generation services and a migration through the pool once pooling is on", () => {
    const files = { "package.json": pkg(), "scripts/gcp-infra.sh": infra(true), "scripts/deploy.sh": deploy() };
    assert.deepEqual(ids(files, "google-cloud/pooling-gen1"), ["google-cloud/pooling-gen1 scripts/deploy.sh:3"]);
    assert.deepEqual(ids(files, "google-cloud/migrate-through-pool"), ["google-cloud/migrate-through-pool scripts/deploy.sh:2"]);
  });

  it("says nothing with gen2 services and a direct migration connection", () => {
    const files = { "package.json": pkg(), "scripts/gcp-infra.sh": infra(true), "scripts/deploy.sh": deploy({ gen2: true, direct: true }) };
    assert.deepEqual(ids(files, "google-cloud/pooling-gen1"), []);
    assert.deepEqual(ids(files, "google-cloud/migrate-through-pool"), []);
  });

  it("says nothing when the repo never turns pooling on", () => {
    const files = { "package.json": pkg({ "graphile-worker": "^0.16.6" }), "scripts/gcp-infra.sh": infra(false), "scripts/deploy.sh": deploy() };
    for (const id of ["google-cloud/pooling-gen1", "google-cloud/migrate-through-pool", "google-cloud/listen-through-pool"]) assert.deepEqual(ids(files, id), []);
  });

  it("warns about Graphile Worker and the app's own LISTEN through the pool, not about a word in the UI", () => {
    const files = {
      "package.json": pkg({ "graphile-worker": "^0.16.6" }),
      "scripts/gcp-infra.sh": infra(true),
      "app/services/listen.server.ts": 'export async function watch(client: any) {\n  await client.query("LISTEN shop_changes");\n}\n',
      "app/routes/app._index.tsx": 'export default function Index() {\n  return <p>{"Listen for new orders"}</p>;\n}\n',
    };
    assert.deepEqual(ids(files, "google-cloud/listen-through-pool"), ["google-cloud/listen-through-pool app/services/listen.server.ts:2", "google-cloud/listen-through-pool package.json:1"]);
  });
});

describe("google-cloud/smtp-port-25", () => {
  const pkg = JSON.stringify({ name: "my-app", dependencies: { "@google-cloud/tasks": "^6.2.0", nodemailer: "^7.0.10" } });
  const mail = (transport: string) => ({ "package.json": pkg, "app/services/mail.server.ts": `import nodemailer from "nodemailer";\nexport const mailer = nodemailer.createTransport(${transport});\n` });
  const smtp = (dir: string) => where(preflight(dir, ["google-cloud"]).findings.filter((f) => f.id === "google-cloud/smtp-port-25"));

  it("warns about port 25, as an option or in a URL", () => {
    withApp(mail('{ host: "smtp.example.com", port: 25 }'), (dir) => assert.deepEqual(smtp(dir), ["google-cloud/smtp-port-25 app/services/mail.server.ts:2"]));
    withApp(mail('"smtp://user:pass@smtp.example.com:25"'), (dir) => assert.deepEqual(smtp(dir), ["google-cloud/smtp-port-25 app/services/mail.server.ts:2"]));
  });

  it("says nothing for 587, 2525, or no port", () => {
    for (const t of ['{ host: "smtp.example.com", port: 587 }', '{ host: "smtp.example.com", port: 2525 }', '{ host: "smtp.example.com" }']) withApp(mail(t), (dir) => assert.deepEqual(smtp(dir), []));
  });
});

describe("scheduled task names", () => {
  const pkg = JSON.stringify({ name: "my-app", dependencies: { "@google-cloud/tasks": "^6.2.0" } });
  const route = (body: string) => ({
    "package.json": pkg,
    "app/routes/schedules.prune-audit-logs.tsx": ['import type { ActionFunctionArgs } from "react-router";', 'import { enqueue } from "../tasks.server";', "export const action = async ({ request }: ActionFunctionArgs) => {", '  if (process.env.K_SERVICE !== "my-app-worker") return new Response(null, { status: 404 });', body, "  return new Response();", "};"].join("\n") + "\n",
  });
  const found = (files: Record<string, string>, id: string) => {
    let out: string[] = [];
    withApp(files, (dir) => (out = where(preflight(dir, ["google-cloud"]).findings.filter((f) => f.id === id))));
    return out;
  };

  it("warns when a scheduled route names its task from the clock", () => {
    const files = route('  const day = new Date().toISOString().slice(0, 10);\n  await enqueue("scheduled", "tasks/prune-audit-logs", {}, { key: `prune-audit-logs-${day}` });');
    assert.deepEqual(found(files, "google-cloud/schedule-name-from-clock"), ["google-cloud/schedule-name-from-clock app/routes/schedules.prune-audit-logs.tsx:6"]);
  });

  it("says nothing when the name comes from X-CloudScheduler-ScheduleTime", () => {
    const files = route('  const scheduleTime = request.headers.get("X-CloudScheduler-ScheduleTime");\n  if (!scheduleTime) return new Response(null, { status: 400 });\n  await enqueue("scheduled", "tasks/prune-audit-logs", {}, { key: `prune-audit-logs-${scheduleTime}` });');
    assert.deepEqual(found(files, "google-cloud/schedule-name-from-clock"), []);
  });

  it("warns about a task name that ends in a timestamp or id, not one that ends in a hash", () => {
    const tasks = (name: string) => ({ "package.json": pkg, "app/tasks.server.ts": `import { createHash } from "node:crypto";\nexport function taskName(parent: string, run: string, key: string) {\n  const hashed = createHash("sha256").update(key).digest("hex");\n  return { name: ${name} };\n}\n` });
    assert.deepEqual(found(tasks("`${parent}/tasks/prune-audit-logs-${run}`"), "google-cloud/task-name-sequential"), ["google-cloud/task-name-sequential app/tasks.server.ts:4"]);
    assert.deepEqual(found(tasks("`${parent}/tasks/${hashed}`"), "google-cloud/task-name-sequential"), []);
    assert.deepEqual(found(tasks('`${parent}/tasks/${createHash("sha256").update(key).digest("hex")}`'), "google-cloud/task-name-sequential"), []);
  });
});

describe("google-cloud/worker-pool-instances", () => {
  const app = (flags: string) => ({ "package.json": JSON.stringify({ name: "my-app", dependencies: { bullmq: "^5.58.0" } }), "scripts/deploy.sh": `set -euo pipefail\ngcloud run deploy my-app-web --image=img --region=us-central1\ngcloud run worker-pools deploy my-app-worker --image=img --region=us-central1${flags}\n` });
  const pools = (dir: string) => preflight(dir, ["google-cloud"]).findings.filter((f) => f.id === "google-cloud/worker-pool-instances");

  it("asks for a fixed count when the deploy sets none", () => {
    withApp(app(""), (dir) => {
      const found = pools(dir);
      assert.deepEqual(where(found), ["google-cloud/worker-pool-instances scripts/deploy.sh:3"]);
      assert.equal(found[0].severity, "manual");
    });
  });

  it("says nothing with --instances", () => {
    withApp(app(" --instances=3"), (dir) => assert.deepEqual(pools(dir), []));
  });
});

describe("google-cloud/enqueue-for-shop-in-request", () => {
  const pkg = JSON.stringify({ name: "my-app", dependencies: { "@google-cloud/tasks": "^6.2.0" } });
  const call = 'import { enqueueForShop } from "../tasks.server";\nexport const action = async () => {\n  await enqueueForShop("1", "tasks/notify-external-system", {}, { key: "notify-1" });\n  return new Response();\n};\n';
  const found = (path: string) => {
    let out: string[] = [];
    withApp({ "package.json": pkg, [path]: call }, (dir) => (out = where(preflight(dir, ["google-cloud"]).findings.filter((f) => f.id === "google-cloud/enqueue-for-shop-in-request"))));
    return out;
  };

  it("warns about enqueueForShop in a webhook route", () => {
    assert.deepEqual(found("app/routes/webhooks.orders.create.tsx"), ["google-cloud/enqueue-for-shop-in-request app/routes/webhooks.orders.create.tsx:3"]);
  });

  it("says nothing in a task route", () => {
    assert.deepEqual(found("app/routes/tasks.order-created.tsx"), []);
  });
});
