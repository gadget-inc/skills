// Run with: node --test "tests/**/*.test.ts"
// The AWS checks in scripts/checks/aws.ts, on the fixtures in fixtures/preflight/aws-*, and on the
// complete examples in references/platforms/aws.md, which must pass their own checks.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { preflight } from "../../skills/gadget/gadget-migration/scripts/preflight.ts";
import { block, platformBlocks } from "./platform-blocks.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/preflight/${name}`, import.meta.url));
const where = (findings: { id: string; file?: string; line?: number }[]) => findings.map((f) => `${f.id} ${f.file ?? ""}${f.line ? `:${f.line}` : ""}`.trim()).sort();
const own = (findings: { id: string }[]) => findings.filter((f) => f.id.startsWith("aws/"));

function withApp(files: Record<string, string>, test: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "aws-"));
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

const run = (files: Record<string, string>, id?: string) => {
  let out: ReturnType<typeof own> & { id: string; file?: string; line?: number; message: string; fix: string; severity: string; error?: string }[] = [];
  withApp(files, (dir) => (out = own(preflight(dir, ["aws"]).findings).filter((f) => !id || f.id === id) as typeof out));
  return out;
};

const shopifyServer = 'import { shopifyApp } from "@shopify/shopify-app-react-router/server";\nexport default shopifyApp({ apiKey: process.env.SHOPIFY_API_KEY, apiSecretKey: process.env.SHOPIFY_API_SECRET || "", appUrl: process.env.SHOPIFY_APP_URL || "" });\n';
const ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-app";
const taskDef = (family: string, command: string[], secrets: [string, string][], extra: Record<string, unknown> = {}, role = "my-app-execution") =>
  JSON.stringify({
    family,
    requiresCompatibilities: ["FARGATE"],
    executionRoleArn: `arn:aws:iam::123456789012:role/${role}`,
    containerDefinitions: [{ name: "app", image: "IMAGE", command, ...extra, secrets: secrets.map(([name, valueFrom]) => ({ name, valueFrom })) }],
  }, null, 2);
const rls = 'ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;\n';

describe("AWS checks", () => {
  it("finds each pitfall in the bad fixture, at its line", () => {
    const { findings } = preflight(fixture("aws-bad"), ["aws"]);
    assert.deepEqual(where(own(findings)), [
      "aws/backup-retention scripts/setup.sh:4",
      "aws/health-check-grace scripts/setup.sh:27",
      "aws/migrate-before-deploy scripts/deploy.sh:7",
      "aws/migrate-on-start ecs/my-app-worker.json:15",
      "aws/migrate-shared-role ecs/my-app-migrate.json:9",
      "aws/owner-skips-rls ecs/my-app-migrate.json:22",
      "aws/presign-expiry app/services/files.server.ts:9",
      "aws/prisma-generate ecs/my-app-web.json:15",
      "aws/rds-proxy-pinning app/tenancy.server.ts:6",
      "aws/schedule-runs-on-create scripts/setup.sh:23",
      "aws/scheduler-cron scripts/setup.sh:23",
      "aws/scheduler-required scripts/setup.sh:23",
      "aws/scheduler-required scripts/setup.sh:25",
      "aws/serverless-pause scripts/setup.sh:10",
      "aws/shopify-env-missing ecs/my-app-web.json:26",
      "aws/sqs-dlq-retention scripts/setup.sh:16",
      "aws/sqs-endpoint app/queue.server.ts:3",
      "aws/sqs-redrive scripts/setup.sh:21",
      "aws/stop-timeout ecs/my-app-worker.json:12",
      "aws/storage-encrypted scripts/setup.sh:4",
    ]);
    const byId = (id: string) => own(findings).filter((f) => f.id === id);
    for (const f of own(findings)) {
      assert.ok(f.fix.endsWith("."), `${f.id} fix ends with a period`);
      assert.match(f.docs ?? "", /^https:\/\/docs\.gadget\.dev\/guides\/moving-to-another-platform\/aws#/);
    }
    assert.equal(byId("aws/shopify-env-missing")[0].error, "Cannot initialize Shopify API Library. Missing values for: apiSecretKey");
    assert.match(byId("aws/shopify-env-missing")[0].fix, /SHOPIFY_API_SECRET to the container's secrets/);
    assert.match(byId("aws/owner-skips-rls")[0].message, /the secret my-app\/database-url-AbCdEf, and my-app-web reads DATABASE_URL from the same secret/);
    assert.match(byId("aws/scheduler-cron")[0].fix, /cron\(0 2 \? \* 2 \*\) for 0 2 \* \* 1/);
    assert.match(byId("aws/scheduler-required").find((f) => f.line === 25)!.error ?? "", /--schedule-expression, --flexible-time-window, --target/);
    assert.equal(byId("aws/rds-proxy-pinning")[0].severity, "manual");
    assert.equal(byId("aws/schedule-runs-on-create")[0].severity, "manual");
  });

  it("finds nothing in the good fixture, which fixes each one", () => {
    assert.deepEqual(where(own(preflight(fixture("aws-good"), ["aws"]).findings)), []);
  });

  it("drops common/migrate-on-start when every task definition sets a command", () => {
    assert.ok(!preflight(fixture("aws-good")).findings.some((f) => f.id === "common/migrate-on-start"));
    withApp({ "Dockerfile": 'FROM node:22-alpine\nCMD ["npm", "run", "docker-start"]\n', "package.json": JSON.stringify({ scripts: { "docker-start": "npm run setup && npm run start", setup: "prisma migrate deploy" } }), "ecs/web.json": JSON.stringify({ family: "web", containerDefinitions: [{ name: "app", image: "x" }] }) }, (dir) =>
      assert.ok(preflight(dir).findings.some((f) => f.id === "common/migrate-on-start"))
    );
  });

  it("is detected from the SQS SDK, a task definition, or an aws ecs script, and not from the S3 SDK alone", () => {
    assert.ok(preflight(fixture("aws-good")).platforms.some((p) => p.platform === "aws"));
    const detected = (files: Record<string, string>) => {
      let out = false;
      withApp(files, (dir) => (out = preflight(dir).platforms.some((p) => p.platform === "aws")));
      return out;
    };
    assert.ok(detected({ "ecs/web.json": taskDef("web", ["npm", "run", "start"], []) }));
    assert.ok(detected({ "deploy.sh": "aws ecs update-service --cluster my-app --service my-app-web\n" }));
    assert.ok(!detected({ "package.json": JSON.stringify({ dependencies: { "@aws-sdk/client-s3": "3.1167.0" } }) }));
  });

  it("reports a task definition it can't parse", () => {
    const found = run({ "ecs/web.json": '{ "family": "web", "containerDefinitions": [ { "name": "app" ' });
    assert.deepEqual(where(found), ["aws/unreadable-config ecs/web.json"]);
    assert.equal(found[0].severity, "manual");
  });

  it("warns about a stopTimeout over Fargate's 120 on any app container", () => {
    const found = run({ "ecs/web.json": taskDef("my-app-web", ["npm", "run", "start"], [], { stopTimeout: 900 }) }, "aws/stop-timeout");
    assert.equal(found.length, 1);
    assert.match(found[0].message, /sets stopTimeout to 900, and Fargate allows at most 120 seconds/);
    assert.deepEqual(run({ "ecs/web.json": taskDef("my-app-web", ["npm", "run", "start"], []) }, "aws/stop-timeout"), []);
  });

  it("finds the services on the master user when the migration overrides a service's task definition", () => {
    const deploy = "set -e\nTASK=$(aws ecs run-task --cluster my-app --task-definition my-app-web --overrides '{\"containerOverrides\":[{\"name\":\"app\",\"command\":[\"npx\",\"prisma\",\"migrate\",\"deploy\"]}]}' --query 'tasks[0].taskArn' --output text)\n";
    const files = { "migrations/1.sql": rls, "deploy.sh": deploy, "ecs/web.json": taskDef("my-app-web", ["npm", "run", "start"], [["DATABASE_URL", `${ARN}/database-url-AbCdEf`]]) };
    const found = run(files, "aws/owner-skips-rls");
    assert.equal(found.length, 1);
    assert.match(found[0].message, /runs with my-app-web's own task definition/);
    // forced row-level security applies to the owner too
    assert.deepEqual(run({ ...files, "migrations/2.sql": 'ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;\n' }, "aws/owner-skips-rls"), []);
  });

  it("reads Prisma's directUrl as the migration's variable", () => {
    const schema = 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n  directUrl = env("DIRECT_DATABASE_URL")\n}\n';
    const shared = `${ARN}/database-url-AbCdEf`;
    const files = {
      "prisma/schema.prisma": schema,
      "migrations/1.sql": rls,
      "ecs/web.json": taskDef("my-app-web", ["npm", "run", "start"], [["DATABASE_URL", shared]]),
      "ecs/migrate.json": taskDef("my-app-migrate", ["npx", "prisma", "migrate", "deploy"], [["DATABASE_URL", shared], ["DIRECT_DATABASE_URL", `${ARN}/migrate-database-url-MnOpQr`]], {}, "my-app-migrate-execution"),
    };
    assert.deepEqual(run(files, "aws/owner-skips-rls"), []);
  });

  it("translates Gadget's cron to Scheduler's, moving day-of-week numbers up by 1", () => {
    const fixes = (expression: string) => run({ "setup.sh": `aws scheduler create-schedule --name x --schedule-expression "${expression}" --flexible-time-window Mode=OFF --state DISABLED --target '{}'\n` }, "aws/scheduler-cron").map((f) => f.fix);
    assert.match(fixes("cron(0 2 * * *)")[0], /cron\(0 2 \* \* \? \*\) for 0 2 \* \* \*\.$/);
    assert.ok(fixes("cron(0 6 * * 1-5)")[0].includes("cron(0 6 ? * 2-6 *)"));
    assert.match(fixes("cron(0 6 * * 1-5)")[0], /adds 1 to each day number/);
    assert.match(fixes("cron(0 6 * * 0)")[0], /cron\(0 6 \? \* 1 \*\)/);
    assert.equal(fixes("cron(0 2 * * * *)").length, 1, "both day fields set");
    assert.deepEqual(fixes("cron(0 2 * * ? *)"), []);
    assert.deepEqual(fixes("cron(0 2 ? * MON *)"), []);
    // in a function, and in CloudFormation
    assert.equal(run({ "setup.sh": 'schedule prune "cron(0 2 * * *)" pruneAuditLogs\n' }, "aws/scheduler-cron").length, 1);
    assert.equal(run({ "template.yaml": "ScheduleExpression: cron(0 2 * * *)\n", "ecs/web.json": taskDef("web", ["npm", "run", "start"], []) }, "aws/scheduler-cron").length, 1);
  });

  it("asks for the whole definition on update-schedule, and stays silent for disabled or unknown states", () => {
    const create = (state: string) => `aws scheduler create-schedule --name x --schedule-expression "rate(1 hour)" --flexible-time-window Mode=OFF ${state} --target '{}'\n`;
    assert.equal(run({ "s.sh": create("") }, "aws/schedule-runs-on-create").length, 1);
    assert.deepEqual(run({ "s.sh": create("--state DISABLED") }, "aws/schedule-runs-on-create"), []);
    assert.deepEqual(run({ "s.sh": 'STATE="${1:?}"\n' + create('--state "$STATE"') }, "aws/schedule-runs-on-create"), []);
    const update = run({ "s.sh": "aws scheduler update-schedule --name x --state ENABLED --target '{}'\n" }, "aws/scheduler-required");
    assert.equal(update[0].error, "the following arguments are required: --schedule-expression, --flexible-time-window");
  });

  it("checks the deploy script's migration step in order", () => {
    const head = "TASK=$(aws ecs run-task --cluster my-app --task-definition my-app-migrate --launch-type FARGATE --query 'tasks[0].taskArn' --output text)\n";
    const update = "aws ecs update-service --cluster my-app --service my-app-web --task-definition my-app-web\n";
    const wait = 'aws ecs wait tasks-stopped --cluster my-app --tasks "$TASK"\n';
    const check = "EXIT=$(aws ecs describe-tasks --cluster my-app --tasks \"$TASK\" --query 'tasks[0].containers[0].exitCode' --output text)\n[ \"$EXIT\" = \"0\" ] || exit 1\n";
    const ids = (script: string) => run({ "deploy.sh": script }, "aws/migrate-before-deploy").map((f) => `${f.severity}:${f.line}`);
    assert.deepEqual(ids(`set -e\n${head}${update}`), ["error:2"]);
    assert.deepEqual(ids(`set -e\n${head}${wait}${update}`), ["error:3"]);
    assert.deepEqual(ids(`${head}${wait}${check}${update}`), ["warning:1"]);
    assert.deepEqual(ids(`set -euo pipefail\n${head}${wait}${check}${update}`), []);
  });

  it("finds Aurora's minimum capacity of 0 in CloudFormation, Terraform, and CDK, and not 0.5", () => {
    const ids = (files: Record<string, string>) => run({ "ecs/web.json": taskDef("web", ["npm", "run", "start"], []), ...files }, "aws/serverless-pause").map((f) => `${f.file}:${f.line}`);
    assert.deepEqual(ids({ "template.yaml": "Cluster:\n  Type: AWS::RDS::DBCluster\n  Properties:\n    Engine: aurora-postgresql\n    ServerlessV2ScalingConfiguration:\n      MinCapacity: 0\n      MaxCapacity: 16\n" }), ["template.yaml:6"]);
    assert.deepEqual(ids({ "main.tf": 'resource "aws_rds_cluster" "db" {\n  engine = "aurora-postgresql"\n  serverlessv2_scaling_configuration {\n    min_capacity = 0\n    max_capacity = 16\n  }\n}\n' }), ["main.tf:4"]);
    assert.deepEqual(ids({ "infra/db.ts": "new rds.DatabaseCluster(this, 'db', { engine, serverlessV2MinCapacity: 0, serverlessV2MaxCapacity: 16 });\n" }), ["infra/db.ts:1"]);
    assert.deepEqual(ids({ "template.yaml": "ServerlessV2ScalingConfiguration:\n  MinCapacity: 0.5\n" }), []);
  });

  it("leaves the SQS client alone without an emulator, and presigned URLs of an hour or less", () => {
    const client = "import { SQSClient } from \"@aws-sdk/client-sqs\";\nexport const sqs = new SQSClient({});\n";
    assert.deepEqual(run({ "app/queue.server.ts": client }, "aws/sqs-endpoint"), []);
    assert.equal(run({ "app/queue.server.ts": client, "docker-compose.yml": "services:\n  app:\n    environment:\n      AWS_ENDPOINT_URL: https://127.0.0.1:9297\n" }, "aws/sqs-endpoint").length, 1);
    const sign = (expires: string) => `import { getSignedUrl } from "@aws-sdk/s3-request-presigner";\nexport const url = () => getSignedUrl(s3, new GetObjectCommand({ Bucket: "b", Key: "k" }), { expiresIn: ${expires} });\n`;
    const files = (expires: string) => ({ "package.json": JSON.stringify({ dependencies: { "@aws-sdk/client-sqs": "3.1167.0" } }), "app/files.server.ts": sign(expires) });
    assert.deepEqual(run(files("15 * 60"), "aws/presign-expiry"), []);
    assert.deepEqual(run(files("3600"), "aws/presign-expiry"), []);
    assert.match(run(files("7 * 24 * 60 * 60"), "aws/presign-expiry")[0].message, /for 168 hours/);
  });

  it("only flags RDS Proxy pinning when the app uses a proxy", () => {
    const code = { "app/tenancy.server.ts": "await tx.$executeRaw`select set_config('app.shop_id', ${id}, true)`;\n", "ecs/web.json": taskDef("web", ["npm", "run", "start"], []) };
    assert.deepEqual(run(code, "aws/rds-proxy-pinning"), []);
    assert.equal(run({ ...code, ".env.example": "DATABASE_URL=postgresql://app_user:x@my-app.proxy-abcdefghijkl.us-east-1.rds.amazonaws.com:5432/shopify_app\n" }, "aws/rds-proxy-pinning").length, 1);
    // a transaction-level lock doesn't pin
    assert.deepEqual(run({ ...code, "app/tenancy.server.ts": "await tx.$queryRaw`select pg_try_advisory_xact_lock(1)`;\n", ".env.example": "X=my-app.proxy-abcdefghijkl.us-east-1.rds.amazonaws.com\n" }, "aws/rds-proxy-pinning"), []);
  });

  it("passes the complete examples in aws.md", () => {
    const files: Record<string, string> = {};
    for (const b of platformBlocks("aws.md")) files[b.path] = b.code;
    // the guide's web task definition: the worker's with the web command and port
    files["ecs/my-app-web.json"] = block("aws.md", "ecs/my-app-worker.json").replace('"my-app-worker"', '"my-app-web"').replace('["npm", "run", "worker"]', '["npm", "run", "start"],\n      "portMappings": [{ "containerPort": 3000 }]');
    files["prisma/migrations/2_shop_isolation/migration.sql"] = rls;
    files["app/shopify.server.ts"] = shopifyServer;
    files["Dockerfile"] = 'FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nRUN npx prisma generate\nRUN npm run build\nCMD ["npm", "run", "start"]\n';
    files["package.json"] = JSON.stringify({ scripts: { start: "react-router-serve ./build/server/index.js", worker: "node build/worker.js" }, dependencies: { "@aws-sdk/client-sqs": "3.1167.0", "@aws-sdk/client-scheduler": "3.1167.0", "@prisma/client": "6.19.3", prisma: "6.19.3" } });
    files[".env.example"] = "AWS_ENDPOINT_URL=https://127.0.0.1:9297\n";
    withApp(files, (dir) => assert.deepEqual(where(own(preflight(dir, ["aws"]).findings)), []));
  });
});
