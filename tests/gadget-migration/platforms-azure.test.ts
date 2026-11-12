// Run with: node --test "tests/**/*.test.ts"
// The Azure checks in scripts/checks/azure.ts, on the fixtures in fixtures/preflight/azure-*, and on the
// complete examples in references/platforms/azure.md, which must pass their own checks.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { preflight } from "../../skills/gadget/gadget-migration/scripts/preflight.ts";
import { platformBlocks } from "./platform-blocks.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/preflight/${name}`, import.meta.url));
const where = (findings: { id: string; file?: string; line?: number }[]) => findings.map((f) => `${f.id} ${f.file ?? ""}${f.line ? `:${f.line}` : ""}`.trim()).sort();
const own = (findings: { id: string }[]) => findings.filter((f) => f.id.startsWith("azure/"));
const ids = (dir: string, id?: string) => where(own(preflight(dir, ["azure"]).findings).filter((f) => !id || f.id === id));

function withApp(files: Record<string, string>, test: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "azure-"));
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

// every file of a fixture, so a test can change one and keep the rest
function filesOf(name: string): Record<string, string> {
  const root = fixture(name);
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(root, full)] = readFileSync(full, "utf8");
    }
  };
  walk(root);
  return out;
}

const pkg = (deps: Record<string, string>) => JSON.stringify({ name: "my-app", type: "module", scripts: { start: "react-router-serve ./build/server/index.js" }, dependencies: deps });
const AZURE_DEPS = { "@azure/identity": "4.14.1", "@azure/service-bus": "7.10.0", "@azure/storage-blob": "12.34.0" };
const sb = 'import { ServiceBusClient } from "@azure/service-bus";\nconst client = new ServiceBusClient("my-app-production-bus.servicebus.windows.net", credential);\n';

describe("Azure checks", () => {
  it("finds each pitfall in the bad fixture, at its line", () => {
    assert.deepEqual(ids(fixture("azure-bad")), [
      "azure/blob-cors-header scripts/azure-env.sh:10",
      "azure/blob-type-header app/upload.client.ts:2",
      "azure/db-open-to-azure scripts/azure-env.sh:5",
      "azure/duplicate-detection scripts/azure-env.sh:8",
      "azure/duplicate-detection scripts/azure-env.sh:9",
      "azure/extensions-allowlist prisma/migrations/3_vector/migration.sql:1",
      "azure/immediate-retry app/worker.server.ts:8",
      "azure/keyvault-unversioned scripts/azure-apps.sh:7",
      "azure/lock-renewal app/worker.server.ts:6",
      "azure/migrate-before-deploy scripts/deploy.sh:6",
      "azure/migrate-shared-identity scripts/azure-apps.sh:9",
      "azure/owner-skips-rls scripts/azure-apps.sh:9",
      "azure/pgbouncer-prepared scripts/azure-env.sh:7",
      "azure/prisma-generate scripts/azure-apps.sh:5",
      "azure/receive-and-delete app/jobs/drain.ts:7",
      "azure/scheduled-id-clock scripts/enqueue-prune-audit-logs.ts:7",
      "azure/smtp-port-25 app/email.server.ts:5",
      "azure/web-scale-to-zero scripts/azure-apps.sh:5",
    ]);
  });

  it("gives each finding its severity, the error text, and a docs link into the Azure guide", () => {
    const findings = own(preflight(fixture("azure-bad"), ["azure"]).findings);
    const byId = (id: string) => findings.filter((f) => f.id === id);
    assert.equal(byId("azure/owner-skips-rls")[0].severity, "error");
    assert.match(byId("azure/owner-skips-rls")[0].message, /Key Vault secret database-url, and the app my-app-web reads DATABASE_URL from the same secret/);
    assert.equal(byId("azure/migrate-shared-identity")[0].severity, "warning");
    assert.match(byId("azure/migrate-shared-identity")[0].message, /managed identity my-app, which my-app-web uses too/);
    assert.equal(byId("azure/pgbouncer-prepared")[0].error, 'prepared statement "s0" does not exist');
    assert.equal(byId("azure/lock-renewal")[0].error, "MessageLockLost");
    assert.match(byId("azure/db-open-to-azure")[0].message, /every Azure address/);
    assert.deepEqual(byId("azure/duplicate-detection").map((f) => f.severity).sort(), ["error", "warning"]);
    assert.equal(byId("azure/prisma-generate")[0].error, "@prisma/client did not initialize yet");
    for (const f of findings) assert.match(f.docs ?? "", /^https:\/\/docs\.gadget\.dev\/guides\/moving-to-another-platform\/azure#/, f.id);
  });

  it("says nothing about the good fixture, and detects it", () => {
    assert.deepEqual(ids(fixture("azure-good")), []);
    assert.ok(preflight(fixture("azure-good")).platforms.some((p) => p.platform === "azure"));
  });

  it("detects az scripts, Bicep, and the SDKs, and leaves other apps alone", () => {
    withApp({ "deploy.sh": "az containerapp update --name my-app-web --image x\n" }, (dir) => assert.ok(preflight(dir).platforms.some((p) => p.platform === "azure")));
    withApp({ "infra/main.bicep": "resource app 'Microsoft.App/containerApps@2024-03-01' = {}\n" }, (dir) => assert.ok(preflight(dir).platforms.some((p) => p.platform === "azure")));
    withApp({ "package.json": pkg({ "@azure/storage-blob": "12.34.0" }) }, (dir) => assert.ok(preflight(dir).platforms.some((p) => p.platform === "azure")));
    withApp({ "package.json": pkg({ bullmq: "6.7.3" }), "deploy.sh": "gcloud run deploy my-app-web --image=x\n" }, (dir) => assert.ok(!preflight(dir).platforms.some((p) => p.platform === "azure")));
  });

  it("suppresses common/migrate-on-start only when every app passes --command", () => {
    const docker = 'FROM node:22-alpine\nCOPY . .\nRUN npx prisma generate\nCMD ["npm", "run", "docker-start"]\n';
    const scripts = { start: "react-router-serve ./build/server/index.js", "docker-start": "npm run setup && npm run start", setup: "prisma generate && prisma migrate deploy" };
    const app = (commands: string) => ({ Dockerfile: docker, "package.json": JSON.stringify({ scripts, dependencies: { "@prisma/client": "6.19.3" } }), "deploy.sh": commands });
    const migrateOnStart = (dir: string) => preflight(dir).findings.some((f) => f.id === "common/migrate-on-start");
    withApp(app("az containerapp create --name my-app-web --image x --command npm --args run start\n"), (dir) => assert.equal(migrateOnStart(dir), false));
    withApp(app("az containerapp create --name my-app-web --image x\n"), (dir) => assert.equal(migrateOnStart(dir), true));
  });
});

describe("azure/lock-renewal and azure/receive-and-delete", () => {
  const worker = (code: string) => ({ "package.json": pkg(AZURE_DEPS), "app/worker.server.ts": sb + code });
  it("passes a receiver that renews for longer than the default, or reads its options from a variable", () => {
    withApp(worker('const receiver = client.createReceiver("webhooks", { maxAutoLockRenewalDurationInMs: 15 * 60 * 1000 });\n'), (dir) => assert.deepEqual(ids(dir), []));
    withApp(worker('const receiver = client.createReceiver("webhooks", options);\n'), (dir) => assert.deepEqual(ids(dir), []));
    withApp(worker('const receiver = client.createReceiver("webhooks", { ...defaults });\n'), (dir) => assert.deepEqual(ids(dir), []));
    withApp(worker('const session = await client.acceptNextSession("orders", { maxAutoLockRenewalDurationInMs: 600000 });\n'), (dir) => assert.deepEqual(ids(dir), []));
  });
  it("flags renewal turned off, a session receiver on the default, and receiveAndDelete", () => {
    withApp(worker('const receiver = client.createReceiver("webhooks", { maxAutoLockRenewalDurationInMs: 0 });\n'), (dir) => assert.deepEqual(ids(dir), ["azure/lock-renewal app/worker.server.ts:3"]));
    withApp(worker('const session = await client.acceptNextSession("orders");\n'), (dir) => assert.deepEqual(ids(dir), ["azure/lock-renewal app/worker.server.ts:3"]));
    withApp(worker('const receiver = client.createReceiver("my-topic", "my-subscription", { receiveMode: "receiveAndDelete" });\n'), (dir) => assert.deepEqual(ids(dir), ["azure/receive-and-delete app/worker.server.ts:3"]));
  });
  it("ignores a createReceiver that isn't Service Bus's", () => {
    withApp({ "package.json": pkg(AZURE_DEPS), "app/x.ts": 'const receiver = other.createReceiver("webhooks");\n' }, (dir) => assert.deepEqual(ids(dir), []));
  });
});

describe("azure/immediate-retry", () => {
  const renew = 'const receiver = client.createReceiver("webhooks", { maxAutoLockRenewalDurationInMs: 900000 });\n';
  const worker = (code: string) => ({ "package.json": pkg(AZURE_DEPS), "app/worker.server.ts": sb + renew + code });
  const handlers = "{ processMessage: async (message) => handle(message), processError: async () => {} }";
  it("passes a handler that settles messages itself, or one that schedules a delayed copy", () => {
    withApp(worker(`receiver.subscribe(${handlers}, { autoCompleteMessages: false });\n`), (dir) => assert.deepEqual(ids(dir), []));
    withApp(worker(`receiver.subscribe(${handlers});\nawait sender.scheduleMessages(copy, later);\n`), (dir) => assert.deepEqual(ids(dir), []));
    // the long job: receive one message, complete it on success, and let its lock expire on failure
    withApp(worker("const [message] = await receiver.receiveMessages(1);\nawait receiver.completeMessage(message);\n"), (dir) => assert.deepEqual(ids(dir), []));
  });
  it("flags autoCompleteMessages left on, and abandonMessage with no delayed copy", () => {
    withApp(worker(`receiver.subscribe(${handlers}, { maxConcurrentCalls: 10 });\n`), (dir) => assert.deepEqual(ids(dir), ["azure/immediate-retry app/worker.server.ts:4"]));
    withApp(worker(`receiver.subscribe(${handlers}, { autoCompleteMessages: false });\nawait receiver.abandonMessage(message);\n`), (dir) => assert.deepEqual(ids(dir), ["azure/immediate-retry app/worker.server.ts:5"]));
  });
});

describe("azure/keyvault-unversioned", () => {
  const script = (ref: string) => ({ "deploy.sh": `az containerapp secret set --name my-app-web --secrets "shopify-api-secret=keyvaultref:${ref},identityref:$IDENTITY_ID"\n` });
  it("passes a reference pinned to a version, literal or from a variable", () => {
    withApp(script("https://my-app-vault.vault.azure.net/secrets/shopify-api-secret/0f3c2a9d8e7b4c1a9f6e5d4c3b2a1f0e"), (dir) => assert.deepEqual(ids(dir), []));
    withApp(script("https://my-app-vault.vault.azure.net/secrets/shopify-api-secret/$VERSION"), (dir) => assert.deepEqual(ids(dir), []));
  });
  it("flags a reference with no version, with or without a trailing slash, in a script or Container Apps YAML", () => {
    withApp(script("https://my-app-vault.vault.azure.net/secrets/shopify-api-secret"), (dir) => assert.deepEqual(ids(dir), ["azure/keyvault-unversioned deploy.sh:1"]));
    withApp(script("https://my-app-vault.vault.azure.net/secrets/shopify-api-secret/"), (dir) => assert.deepEqual(ids(dir), ["azure/keyvault-unversioned deploy.sh:1"]));
    const yaml = "properties:\n  configuration:\n    secrets:\n      - name: shopify-api-secret\n        keyVaultUrl: https://my-app-vault.vault.azure.net/secrets/shopify-api-secret\n        identity: system\n";
    withApp({ "containerapp.yaml": yaml, "deploy.sh": "az containerapp update --name my-app-web --yaml containerapp.yaml\n" }, (dir) => assert.deepEqual(ids(dir), ["azure/keyvault-unversioned containerapp.yaml:5"]));
  });
});

describe("Flexible Server checks", () => {
  const enable = "az postgres flexible-server parameter set --resource-group my-app-production --server-name my-app-db --name pgbouncer.enabled --value true\n";
  it("passes PgBouncer with max_prepared_statements raised, or with pgbouncer=true anywhere in the repository", () => {
    const prepared = enable + "az postgres flexible-server parameter set --resource-group my-app-production --server-name my-app-db --name pgbouncer.max_prepared_statements --value 200\n";
    withApp({ "package.json": pkg({ "@prisma/client": "6.19.3" }), "setup.sh": prepared }, (dir) => assert.deepEqual(ids(dir), []));
    withApp({ "package.json": pkg({ "@prisma/client": "6.19.3" }), "setup.sh": enable, ".env.example": "DATABASE_URL=postgresql://app_user:x@my-app-db.postgres.database.azure.com:6432/shopify_app?sslmode=require&pgbouncer=true\n" }, (dir) => assert.deepEqual(ids(dir), []));
    // a client that doesn't prepare named statements
    withApp({ "package.json": pkg({ pg: "8.23.1" }), "setup.sh": enable }, (dir) => assert.deepEqual(ids(dir), []));
  });
  it("tells the internet apart from Azure in an open firewall, and passes a single address", () => {
    const rule = (start: string, end?: string) => ({ "setup.sh": `az postgres flexible-server firewall-rule create --resource-group g --server-name my-app-db --name r --start-ip-address ${start}${end ? ` --end-ip-address ${end}` : ""}\n` });
    withApp(rule("0.0.0.0", "255.255.255.255"), (dir) => assert.match(own(preflight(dir, ["azure"]).findings)[0].message, /every address on the internet/));
    withApp(rule("0.0.0.0", "0.0.0.0"), (dir) => assert.match(own(preflight(dir, ["azure"]).findings)[0].message, /every Azure address/));
    withApp(rule("20.121.33.44"), (dir) => assert.deepEqual(ids(dir), []));
    withApp({ "setup.sh": "az postgres flexible-server create --resource-group g --name my-app-db --public-access All\n" }, (dir) => assert.match(own(preflight(dir, ["azure"]).findings)[0].message, /every address on the internet/));
  });
  it("checks the extension allowlist only when the scripts create the server, and ignores plpgsql", () => {
    const sql = { "prisma/migrations/1_init/migration.sql": 'CREATE EXTENSION IF NOT EXISTS "vector";\nCREATE EXTENSION IF NOT EXISTS plpgsql;\n' };
    withApp({ ...sql, "setup.sh": "az postgres flexible-server parameter set --server-name my-app-db --name pgbouncer.enabled --value false\n" }, (dir) => assert.deepEqual(ids(dir), []));
    const create = "az postgres flexible-server create --resource-group g --name my-app-db --public-access None\n";
    withApp({ ...sql, "setup.sh": create }, (dir) => assert.deepEqual(ids(dir), ["azure/extensions-allowlist prisma/migrations/1_init/migration.sql:1"]));
    withApp({ ...sql, "setup.sh": create + "az postgres flexible-server parameter set --server-name my-app-db --name azure.extensions --value pg_trgm,VECTOR\n" }, (dir) => assert.deepEqual(ids(dir), []));
  });
});

describe("Container Apps checks", () => {
  it("flags only external apps that can scale to zero", () => {
    withApp({ "a.sh": "az containerapp create --name my-app-web --ingress external --min-replicas 0\n" }, (dir) => assert.deepEqual(ids(dir), ["azure/web-scale-to-zero a.sh:1"]));
    withApp({ "a.sh": "az containerapp create --name my-app-web --ingress external --min-replicas 1\n" }, (dir) => assert.deepEqual(ids(dir), []));
    withApp({ "a.sh": "az containerapp create --name my-app-worker --min-replicas 0\n" }, (dir) => assert.deepEqual(ids(dir), []));
  });

  it("reads secrets through arrays and command substitutions, as in the complete example", () => {
    const files = filesOf("azure-good");
    // the migration job reading the apps' secret instead of its own
    files["scripts/azure-apps.sh"] = files["scripts/azure-apps.sh"].replace('--env-vars "DATABASE_URL=secretref:migrate-database-url"', '--secrets "${SECRETS[@]}" --env-vars "DATABASE_URL=secretref:database-url"');
    withApp(files, (dir) => assert.deepEqual(ids(dir, "azure/owner-skips-rls"), ["azure/owner-skips-rls scripts/azure-apps.sh:70"]));
  });

  it("passes when the app and the migration job read different secrets, or every protected table forces row-level security", () => {
    const files = filesOf("azure-bad");
    const apps = files["scripts/azure-apps.sh"];
    withApp({ ...files, "scripts/azure-apps.sh": apps.replace("secrets/database-url/0f3c", "secrets/migrate-database-url/0f3c") }, (dir) => assert.deepEqual(ids(dir, "azure/owner-skips-rls"), []));
    withApp({ ...files, "prisma/migrations/4_force/migration.sql": 'ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;\n' }, (dir) => assert.deepEqual(ids(dir, "azure/owner-skips-rls"), []));
  });

  it("passes a deploy that polls the execution, warns without set -e, and flags a migration job that never starts", () => {
    const head = "az containerapp job create --name my-app-migrate --command npx --args prisma migrate deploy\n";
    const poll = 'EXECUTION="$(az containerapp job start --name my-app-migrate --query name --output tsv)"\nSTATUS="$(az containerapp job execution show --name my-app-migrate --job-execution-name "$EXECUTION" --query properties.status --output tsv)"\naz containerapp update --name my-app-web --image x\n';
    withApp({ "jobs.sh": head, "deploy.sh": `set -euo pipefail\n${poll}` }, (dir) => assert.deepEqual(ids(dir), []));
    withApp({ "jobs.sh": head, "deploy.sh": poll }, (dir) => assert.deepEqual(ids(dir), ["azure/migrate-before-deploy deploy.sh:1"]));
    withApp({ "jobs.sh": head, "deploy.sh": "set -e\naz containerapp job update --name my-app-migrate --image x\naz containerapp update --name my-app-web --image x\n" }, (dir) =>
      assert.deepEqual(ids(dir), ["azure/migrate-before-deploy deploy.sh:2"])
    );
  });
});

describe("azure/duplicate-detection", () => {
  const sender = { "package.json": pkg(AZURE_DEPS), "app/q.ts": sb + 'await client.createSender("webhooks").sendMessages({ body, messageId: webhookId });\n' };
  it("passes the short alias with a long window, and queues in an app that never sets messageId", () => {
    withApp({ ...sender, "s.sh": "az servicebus queue create --resource-group g --namespace-name my-app-bus --name webhooks --duplicate-detection yes -d PT4H\n" }, (dir) => assert.deepEqual(ids(dir), []));
    withApp({ "package.json": pkg(AZURE_DEPS), "s.sh": "az servicebus queue create --resource-group g --namespace-name my-app-bus --name webhooks\n" }, (dir) => assert.deepEqual(ids(dir), []));
  });
  it("flags detection turned off and a window shorter than Shopify's retries", () => {
    withApp({ ...sender, "s.sh": "az servicebus queue create --resource-group g --namespace-name my-app-bus --name webhooks --enable-duplicate-detection false\n" }, (dir) => assert.equal(own(preflight(dir, ["azure"]).findings)[0].severity, "error"));
    withApp({ ...sender, "s.sh": "az servicebus queue create --resource-group g --namespace-name my-app-bus --name webhooks --enable-duplicate-detection true --duplicate-detection-history-time-window PT1H\n" }, (dir) =>
      assert.match(own(preflight(dir, ["azure"]).findings)[0].message, /for PT1H/)
    );
  });
});

describe("azure/scheduled-id-clock", () => {
  const script = (code: string, path = "scripts/enqueue-prune-audit-logs.ts") => ({ "package.json": pkg(AZURE_DEPS), [path]: sb + code });
  it("passes the guide's script, which goes back to the latest 02:00 UTC", () => {
    const guide = 'const scheduledAt = new Date();\nscheduledAt.setUTCHours(2, 0, 0, 0);\nif (scheduledAt.getTime() > Date.now()) scheduledAt.setUTCDate(scheduledAt.getUTCDate() - 1);\nconst messageId = `pruneAuditLogs-${scheduledAt.toISOString()}`;\nawait client.createSender("scheduled").sendMessages({ body, messageId });\n';
    withApp(script(guide), (dir) => assert.deepEqual(ids(dir), []));
  });
  it("flags an id from today's date, inline or through a variable, and leaves app code that isn't scheduled alone", () => {
    withApp(script('await client.createSender("scheduled").sendMessages({ body, messageId: `prune-${new Date().toISOString().slice(0, 10)}` });\n'), (dir) => assert.deepEqual(ids(dir), ["azure/scheduled-id-clock scripts/enqueue-prune-audit-logs.ts:3"]));
    withApp(script('const messageId = `prune-${new Date().toDateString()}`;\nawait client.createSender("scheduled").sendMessages({ body, messageId });\n'), (dir) => assert.deepEqual(ids(dir), ["azure/scheduled-id-clock scripts/enqueue-prune-audit-logs.ts:4"]));
    withApp(script('const day = new Date().toISOString().slice(0, 10);\nawait sender.sendMessages({ body, messageId: `digest-${day}` });\n', "app/routes/digest.tsx"), (dir) => assert.deepEqual(ids(dir), []));
  });
});

describe("Blob Storage and email checks", () => {
  const upload = 'export const send = (file: File, url: string) => fetch(url, { method: "PUT", body: file });\n';
  it("passes an upload whose header is set in another file, and a PUT that isn't a file", () => {
    withApp({ "package.json": pkg(AZURE_DEPS), "app/upload.client.ts": upload, "app/headers.ts": 'export const headers = { "x-ms-blob-type": "BlockBlob" };\n' }, (dir) => assert.deepEqual(ids(dir), []));
    withApp({ "package.json": pkg(AZURE_DEPS), "app/api.ts": 'await fetch("/api/settings", { method: "PUT", body: JSON.stringify(settings) });\n' }, (dir) => assert.deepEqual(ids(dir), []));
    // a host other than Azure: no @azure/storage-blob, no finding
    withApp({ "package.json": pkg({ "@aws-sdk/client-s3": "3.1.0" }), "app/upload.client.ts": upload, "s.sh": "az group create --name g\n" }, (dir) => assert.deepEqual(ids(dir), []));
  });
  it("passes a CORS rule that allows every header", () => {
    withApp({ "package.json": pkg(AZURE_DEPS), "s.sh": "az storage cors add --account-name myappfiles --services b --methods GET PUT --origins https://app.example.com --allowed-headers '*'\n" }, (dir) => assert.deepEqual(ids(dir), []));
  });
  it("passes port 587 and a port from a variable", () => {
    withApp({ "app/mail.ts": 'nodemailer.createTransport({ host, port: 587 });\nnodemailer.createTransport({ host, port: Number(process.env.SMTP_PORT) });\n', "s.sh": "az group create --name g\n" }, (dir) => assert.deepEqual(ids(dir), []));
  });
});

describe("lastScheduledRun in azure.md", () => {
  it("gives the most recent scheduled time at or before now, for daily and hourly schedules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "azure-schedule-"));
    try {
      const code = platformBlocks("azure.md").find((b) => b.path === "app/scheduled-time.server.ts")!.code;
      writeFileSync(join(dir, "scheduled-time.ts"), code);
      const { lastScheduledRun } = await import(join(dir, "scheduled-time.ts"));
      const at = (schedule: string, now: string) => lastScheduledRun(schedule, new Date(now)).toISOString();
      const cases: [string, string, string][] = [
        ["0 2 * * *", "2026-11-10T02:00:00.000Z", "2026-11-10T02:00:00.000Z"], // on time
        ["0 2 * * *", "2026-11-10T23:59:59.999Z", "2026-11-10T02:00:00.000Z"], // a retry before midnight
        ["0 2 * * *", "2026-11-11T00:05:00.000Z", "2026-11-10T02:00:00.000Z"], // after midnight, where the clock's date is the 11th
        ["0 2 * * *", "2026-11-11T01:59:59.999Z", "2026-11-10T02:00:00.000Z"],
        ["0 2 * * *", "2026-12-01T01:00:00.000Z", "2026-11-30T02:00:00.000Z"], // across a month
        ["0 2 * * *", "2027-01-01T00:30:00.000Z", "2026-12-31T02:00:00.000Z"], // across a year
        ["30 23 * * *", "2026-11-11T00:10:00.000Z", "2026-11-10T23:30:00.000Z"], // the guide's 23:30 run retried at 00:10
        ["0 * * * *", "2026-11-10T14:59:00.000Z", "2026-11-10T14:00:00.000Z"],
        ["15 * * * *", "2026-11-11T00:10:00.000Z", "2026-11-10T23:15:00.000Z"], // an hourly run across midnight
      ];
      for (const [schedule, now, expected] of cases) assert.equal(at(schedule, now), expected, `${schedule} at ${now}`);
      for (const schedule of ["*/5 * * * *", "0 2 * * 1", "0 2,14 * * *"]) assert.throws(() => lastScheduledRun(schedule), /reads "M H \* \* \*" and "M \* \* \* \*"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("azure.md complete examples", () => {
  it("pass their own checks", () => {
    const files: Record<string, string> = {};
    for (const b of platformBlocks("azure.md")) files[b.path] = b.code;
    files["prisma/schema.prisma"] = 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n';
    files["prisma/migrations/2_shop_isolation/migration.sql"] = 'ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;\nCREATE EXTENSION IF NOT EXISTS vector;\n';
    files["package.json"] = pkg({ ...AZURE_DEPS, "@prisma/client": "6.19.3", prisma: "6.19.3" });
    files["Dockerfile"] = 'FROM node:22-alpine\nCOPY . .\nRUN npx prisma generate\nCMD ["npm", "run", "start"]\n';
    assert.ok(Object.keys(files).length >= 8, Object.keys(files).join(", "));
    withApp(files, (dir) => assert.deepEqual(ids(dir), []));
  });
});
