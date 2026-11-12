# AWS

## What is this?

On AWS, the app becomes two ECS services on Fargate from one image: `my-app-web` behind an Application Load Balancer, and `my-app-worker`, which reads jobs from SQS. The database is RDS for PostgreSQL, and EventBridge Scheduler replaces scheduled actions. Most failures here come from four places: a task definition that lacks a variable or kills jobs after 30 seconds, services that connect as the master user that owns the tables, a Gadget cron schedule that Scheduler reads differently, and retries that SQS only gives you if you set them up. Gadget's guide: https://docs.gadget.dev/guides/moving-to-another-platform/aws

For AWS itself (ECS, RDS, SQS, IAM, CDK, the SDK), load AWS's core skills: `npx skills add aws/agent-toolkit-for-aws/skills`, or `/plugin install aws-core@claude-plugins-official` in Claude Code (https://github.com/aws/agent-toolkit-for-aws). `aws-containers` has `stopTimeout`'s default and maximum, and `aws-sdk-js-v3-usage` has presigned URLs with signed headers. `aws-serverless` picks EventBridge Scheduler for cron jobs, but no AWS skill covers its six-field cron, its day numbering, or its scheduled-time attribute. They also leave out RDS's master user and row-level security, and the SQS client's endpoint in development, so this file carries those. One suggestion to override: `aws-database` suggests Aurora PostgreSQL Serverless when nothing points elsewhere and lists scale to zero as an option, and a database that pauses fails Shopify's webhooks (`aws/serverless-pause`). This file covers only what breaks or changes because the app came from Gadget.

Read [common.md](common.md) first.

## Checks to run

```bash
node path/to/skills/gadget-migration/scripts/preflight.ts path/to/new-app --platform aws
```

It reads ECS task definitions (JSON files with `containerDefinitions`, as `aws ecs register-task-definition --cli-input-json` takes them), `aws` commands in shell scripts, CI workflows, and Makefiles, with the variables a script assigns, plus the app's SQS and S3 code. It doesn't read CDK, CloudFormation, or Terraform, apart from Aurora's minimum capacity.

| Check | What it catches | Command when the script can't see it |
|---|---|---|
| `aws/stop-timeout` | A worker container with no `stopTimeout`, so ECS kills its job 30 seconds after `SIGTERM`, or a `stopTimeout` over Fargate's 120 | `aws ecs describe-task-definition --task-definition my-app-worker --query 'taskDefinition.containerDefinitions[].stopTimeout'` |
| `aws/shopify-env-missing` | A container that runs the app without `SHOPIFY_APP_URL`, `SHOPIFY_API_KEY`, or `SHOPIFY_API_SECRET` in its environment or secrets | The same command with `[].[environment[].name,secrets[].name]` |
| `aws/prisma-generate` | A task definition `command` that skips the template's `docker-start`, with no `prisma generate` in the Dockerfile | |
| `aws/migrate-on-start` | A service's `command` that runs `prisma migrate deploy` or `db push`, so every task migrates as it starts | |
| `aws/owner-skips-rls` | SQL migrations that turn on row-level security, while the migration task and a service read the database URL from the same secret, so the services connect as the tables' owner | `psql "host=localhost dbname=shopify_app user=app_user sslmode=require" -f path/to/skills/gadget-migration/scripts/db-check.sql` through the Session Manager tunnel |
| `aws/migrate-shared-role` | A migration task definition with the same execution role as a service, so that role can read the master user's URL | `aws secretsmanager get-resource-policy --secret-id my-app/migrate-database-url`, and the IAM policies of each execution role |
| `aws/migrate-before-deploy` | A deploy script that updates the services after `run-task` without waiting for the migration, or that waits but never checks its exit code | |
| `aws/storage-encrypted`, `aws/backup-retention` | `aws rds create-db-instance` without `--storage-encrypted` (the CLI's default is unencrypted, for good) or without `--backup-retention-period` (1 day) | `aws rds describe-db-instances --db-instance-identifier my-app-db --query 'DBInstances[0].[StorageEncrypted,BackupRetentionPeriod]'` |
| `aws/serverless-pause` | Aurora Serverless v2 with a minimum capacity of 0, in a CLI flag, CloudFormation, Terraform, or CDK | `aws rds describe-db-clusters --query 'DBClusters[].ServerlessV2ScalingConfiguration'` |
| `aws/rds-proxy-pinning` | An app that goes through RDS Proxy and calls `set_config` or a session advisory lock, which pin each session | `aws cloudwatch get-metric-statistics --namespace AWS/RDS --metric-name DatabaseConnectionsCurrentlySessionPinned --dimensions Name=ProxyName,Value=my-app --statistics Maximum --period 300 --start-time 2026-11-12T00:00:00Z --end-time 2026-11-13T00:00:00Z` |
| `aws/sqs-redrive`, `aws/sqs-dlq-retention` | A queue with no redrive policy, which retries a failing job until its retention ends, or a dead-letter queue that keeps messages no longer than its source | `aws sqs get-queue-attributes --queue-url "$JOBS_QUEUE_URL" --attribute-names RedrivePolicy MessageRetentionPeriod` |
| `aws/scheduler-cron` | A five-field cron expression, which Scheduler refuses, or one with both day fields set. The fix adds 1 to day-of-week numbers, because Scheduler counts Sunday as 1 | |
| `aws/scheduler-required`, `aws/schedule-runs-on-create` | `create-schedule` without `--flexible-time-window`, `update-schedule` without the whole definition, and every enabled schedule, which runs as soon as it exists | `aws scheduler list-schedules --query 'Schedules[].[Name,State]' --output table` |
| `aws/sqs-endpoint` | An `SQSClient` without `useQueueUrlAsEndpoint: false` in a repo that sets `AWS_ENDPOINT_URL` for a local emulator | |
| `aws/presign-expiry` | An S3 URL signed for more than an hour, which dies early when the task role's credentials rotate | |
| `aws/health-check-grace` | `aws ecs create-service` behind a load balancer without `--health-check-grace-period-seconds` | `aws ecs describe-services --cluster my-app --services my-app-web --query 'services[0].healthCheckGracePeriodSeconds'` |
| The NAT gateways' addresses | Shopify's allowlist needs them | `aws ec2 describe-nat-gateways --query 'NatGateways[].NatGatewayAddresses[].PublicIp' --output text` |
| Connections at full scale | Each service's maximum tasks times its pool size, against `max_connections` | `aws application-autoscaling describe-scalable-targets --service-namespace ecs --query 'ScalableTargets[].[ResourceId,MaxCapacity]'`, then `show max_connections` in `psql` |

## Failure signatures

| You see | Cause | Fix |
|---|---|---|
| `Cannot initialize Shopify API Library. Missing values for: apiSecretKey, apiKey`, and the task stops at startup | A task definition that loads `shopify.server.ts` lacks the Shopify variables, often the worker's or a one-off task's | Add them to every such task definition (`aws/shopify-env-missing`, [Environment variables](https://docs.gadget.dev/guides/moving-to-another-platform/aws#environment-variables)) |
| A job runs twice, the second time about 15 minutes after a deploy | ECS sent `SIGTERM`, then `SIGKILL` after `stopTimeout`, and the job's message came back when its 900-second visibility timeout ended | `stopTimeout` 120 and a `SIGTERM` handler, and run longer jobs with `RunTask` or task scale-in protection (`aws/stop-timeout`, [Check your host's time limits](https://docs.gadget.dev/guides/moving-to-another-platform/aws#check-your-host-s-time-limits)) |
| A job runs twice at the same time, with no deploy | The job ran past the queue's visibility timeout, and another loop received it | A visibility timeout longer than the longest job, or `ChangeMessageVisibility` while it runs |
| `remaining connection slots are reserved`, or `sorry, too many clients already` once every slot is used, during a burst of webhooks | Auto scaling added tasks until their pools passed `max_connections` | A maximum task count for each service, so tasks times pool size stays under it ([Limit connections](https://docs.gadget.dev/guides/moving-to-another-platform/aws#limit-connections)) |
| `no pg_hba.conf entry for host "10.0.1.25", user "app_user", database "shopify_app", no encryption` | RDS for PostgreSQL 15 and later rejects connections without TLS | `sslmode=require` in the URL, or the client's SSL option |
| A query with no store set returns every store's rows | The services connect with the master user's URL, and that user owns the tables | A separate `app_user` secret for the services (`aws/owner-skips-rls`, [Rewrite permissions and shop tenancy](https://docs.gadget.dev/guides/moving-to-another-platform/aws#rewrite-permissions-and-shop-tenancy)) |
| `unrecognized configuration parameter "app.shop_id"`, or `invalid input syntax for type bigint: ""` on a reused connection, from a scheduled job | A job that works across stores runs as `app_user`, with no store set | A `security definer` function owned by the master user, as `prune_audit_logs` below does |
| `Only roles with the BYPASSRLS attribute may create roles with the BYPASSRLS attribute` | The master user has no `BYPASSRLS`, so it can't make the cross-store role [shop-tenancy.md](../shop-tenancy.md#code-that-works-across-stores) describes | The same function |
| `@prisma/client did not initialize yet` | The task definition's `command` replaced `docker-start`, which ran `prisma generate` | `RUN npx prisma generate` after `COPY . .` (`aws/prisma-generate`) |
| `exec format error` when a task starts | The image was built on an ARM Mac, and Fargate runs `X86_64` | `docker build --platform linux/amd64` |
| The deploy script finished, and the app fails on missing columns | `aws ecs wait tasks-stopped` succeeded for a migration that failed, or never started | Read the exit code with `describe-tasks` after the wait (`aws/migrate-before-deploy`) |
| `P3009` on every deploy after the first migration failed | The template's SQLite migration failed once, and Prisma won't run past a failed migration | `prisma migrate resolve --rolled-back <name>`, run as a `my-app-migrate` task with `--overrides` |
| `ValidationException: Invalid Schedule Expression` | A five-field cron copied from Gadget, or `*` in both day fields | `cron(0 2 * * ? *)` (`aws/scheduler-cron`) |
| A weekly job runs a day early | Scheduler numbers the days of the week 1 to 7 from Sunday, so cron's `1` (Monday) became Sunday | Add 1 to each day number: Monday is `2` |
| A nightly job ran twice, or skipped the next night | The job built its id from the clock, so a retry after midnight took the next day's id | Use `<aws.scheduler.scheduled-time>` from the schedule's input, as the job below does |
| `the following arguments are required: --schedule-expression, --flexible-time-window, --target` at the cutover | `update-schedule` replaces the whole schedule, so turning one on needs its whole definition | `scripts/aws-queues.sh ENABLED` below (`aws/scheduler-required`) |
| `InvalidClientTokenId` from SQS in development | The SQS client sent the emulator's credentials to the host in the queue's URL | `new SQSClient({ useQueueUrlAsEndpoint: false })` (`aws/sqs-endpoint`) |
| An S3 link answers `ExpiredToken` long before its expiry | It was signed with task role credentials that expired first | Sign when the page shows the file, with a short expiry (`aws/presign-expiry`) |
| Webhooks time out after a quiet night | Aurora Serverless v2 paused at 0 capacity, and resuming takes about 15 seconds | Minimum capacity above 0 in production (`aws/serverless-pause`) |
| `DatabaseConnectionsCurrentlySessionPinned` matches the proxy's connections | `set_config('app.shop_id', ...)` pins every session | Size pools against `max_connections`, or PgBouncer in transaction mode (`aws/rds-proxy-pinning`, [Connect through RDS Proxy](https://docs.gadget.dev/guides/moving-to-another-platform/aws#connect-through-rds-proxy)) |
| `P1002`, `Timed out trying to acquire a postgres advisory lock` | A migration ran through transaction-mode PgBouncer and left Prisma's lock on a pooled connection | Run migrations on the instance's own endpoint, and end the backend holding lock `72707369` |
| A tenant's jobs run 3 at once, above its limit of 2 | The worker receives up to 10 messages from one FIFO group and runs them side by side | `MaxNumberOfMessages: 1`, as the guide's worker does ([Limit concurrency per store](https://docs.gadget.dev/guides/moving-to-another-platform/aws#limit-concurrency-per-store)) |

## Complete examples

One AWS account per environment, `my-app-staging` and `my-app-production`, with the same resource names in each. The image is the template's Dockerfile with `RUN npx prisma generate` after `COPY . .`.

### Task definitions

The guide shows `my-app-web`'s. The worker's differs in its family, command, and ports, and keeps every Shopify variable, because the jobs import `shopify.server.ts`:

```json
// in ecs/my-app-worker.json
{
  "family": "my-app-worker",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "1024",
  "memory": "2048",
  "executionRoleArn": "arn:aws:iam::123456789012:role/my-app-execution",
  "taskRoleArn": "arn:aws:iam::123456789012:role/my-app-task",
  "containerDefinitions": [
    {
      "name": "app",
      "image": "IMAGE",
      "command": ["npm", "run", "worker"],
      "stopTimeout": 120,
      "linuxParameters": { "initProcessEnabled": true },
      "environment": [
        { "name": "SHOPIFY_APP_URL", "value": "https://app.example.com" },
        { "name": "SHOPIFY_API_KEY", "value": "production-client-id" },
        { "name": "SCOPES", "value": "read_orders" },
        { "name": "JOBS_QUEUE_URL", "value": "https://sqs.us-east-1.amazonaws.com/123456789012/jobs" },
        { "name": "WEBHOOKS_QUEUE_URL", "value": "https://sqs.us-east-1.amazonaws.com/123456789012/webhooks" },
        { "name": "SCHEDULER_ROLE_ARN", "value": "arn:aws:iam::123456789012:role/my-app-scheduler" }
      ],
      "secrets": [
        { "name": "DATABASE_URL", "valueFrom": "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-app/database-url-AbCdEf" },
        { "name": "SHOPIFY_API_SECRET", "valueFrom": "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-app/shopify-api-secret-GhIjKl" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": { "awslogs-group": "/ecs/my-app", "awslogs-region": "us-east-1", "awslogs-stream-prefix": "worker" }
      }
    }
  ]
}
```

The migration task gets the master user's URL from its own secret, through its own execution role, the only role with `secretsmanager:GetSecretValue` on `my-app/migrate-database-url`. That URL uses the instance's endpoint, never the proxy's:

```json
// in ecs/my-app-migrate.json
{
  "family": "my-app-migrate",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "executionRoleArn": "arn:aws:iam::123456789012:role/my-app-migrate-execution",
  "containerDefinitions": [
    {
      "name": "app",
      "image": "IMAGE",
      "command": ["npx", "prisma", "migrate", "deploy"],
      "secrets": [
        { "name": "DATABASE_URL", "valueFrom": "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-app/migrate-database-url-MnOpQr" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": { "awslogs-group": "/ecs/my-app", "awslogs-region": "us-east-1", "awslogs-stream-prefix": "migrate" }
      }
    }
  ]
}
```

Run `prisma migrate resolve` with the same task definition and a command override, so it reads the same secret: `aws ecs run-task --cluster my-app --task-definition my-app-migrate --launch-type FARGATE --network-configuration "$NETWORK" --overrides '{"containerOverrides":[{"name":"app","command":["npx","prisma","migrate","resolve","--rolled-back","20240530213853_create_session_table"]}]}'`.

### Queues and schedules

The queues with Gadget's retry counts, and the scheduler's role and schedules. Run it with `DISABLED` when you set up an account, and with `ENABLED` in the cutover's "Move scheduled work" step. Each schedule is created once and then replaced whole, because `update-schedule` takes the whole definition:

```bash
# in scripts/aws-queues.sh
# usage: bash scripts/aws-queues.sh DISABLED   or   bash scripts/aws-queues.sh ENABLED
# run with the account's credentials; the script makes the same resources in staging and production
set -euo pipefail
STATE="${1:?usage: aws-queues.sh DISABLED|ENABLED}"
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
ARN="arn:aws:sqs:${REGION}:${ACCOUNT}"

# a dead-letter queue keeps a message's first enqueue time, so it keeps them for 14 days, the most SQS allows
queue_with_dlq() {
  local name="$1" receives="$2" visibility="$3"
  aws sqs create-queue --queue-name "${name}-dlq" --attributes MessageRetentionPeriod=1209600 > /dev/null
  # maxReceiveCount counts the first attempt: 7 is Gadget's 6 retries for actions, 10 its attempts for webhooks
  aws sqs create-queue --queue-name "$name" --attributes "{
    \"VisibilityTimeout\": \"${visibility}\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"${ARN}:${name}-dlq\\\",\\\"maxReceiveCount\\\":\\\"${receives}\\\"}\"
  }" > /dev/null
}
queue_with_dlq jobs 7 900
queue_with_dlq webhooks 10 120

# a FIFO queue's dead-letter queue must be FIFO too; one message group per store and slot, as in the guide
aws sqs create-queue --queue-name external-dlq.fifo --attributes FifoQueue=true,MessageRetentionPeriod=1209600 > /dev/null
aws sqs create-queue --queue-name external.fifo --attributes "{
  \"FifoQueue\": \"true\",
  \"VisibilityTimeout\": \"900\",
  \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"${ARN}:external-dlq.fifo\\\",\\\"maxReceiveCount\\\":\\\"7\\\"}\"
}" > /dev/null

# Scheduler sends to the queues as this role, for recurring schedules and for the one-time schedules app/queue.server.ts creates
if ! aws iam get-role --role-name my-app-scheduler > /dev/null 2>&1; then
  aws iam create-role --role-name my-app-scheduler --assume-role-policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{ \"Effect\": \"Allow\", \"Principal\": { \"Service\": \"scheduler.amazonaws.com\" }, \"Action\": \"sts:AssumeRole\",
      \"Condition\": { \"StringEquals\": { \"aws:SourceAccount\": \"${ACCOUNT}\" } } }]
  }" > /dev/null
fi
aws iam put-role-policy --role-name my-app-scheduler --policy-name send-jobs --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{ \"Effect\": \"Allow\", \"Action\": \"sqs:SendMessage\", \"Resource\": [\"${ARN}:jobs\", \"${ARN}:jobs-dlq\"] }]
}"

# one Gadget scheduled action: name, Scheduler's six-field cron, and the job the worker runs.
# the input carries the run's scheduled time, which stays the same across Scheduler's retries and duplicate deliveries
schedule() {
  local name="$1" expression="$2" job="$3"
  local verb=create-schedule
  if aws scheduler get-schedule --name "$name" > /dev/null 2>&1; then verb=update-schedule; fi
  aws scheduler "$verb" --name "$name" --state "$STATE" \
    --schedule-expression "$expression" --schedule-expression-timezone UTC --flexible-time-window Mode=OFF \
    --target "{
      \"Arn\": \"${ARN}:jobs\",
      \"RoleArn\": \"arn:aws:iam::${ACCOUNT}:role/my-app-scheduler\",
      \"Input\": \"{\\\"job\\\":\\\"${job}\\\",\\\"payload\\\":{\\\"scheduledTime\\\":\\\"<aws.scheduler.scheduled-time>\\\"}}\",
      \"RetryPolicy\": { \"MaximumRetryAttempts\": 5, \"MaximumEventAgeInSeconds\": 3600 },
      \"DeadLetterConfig\": { \"Arn\": \"${ARN}:jobs-dlq\" }
    }" > /dev/null
  echo "$name: $STATE"
}
# Gadget's 0 2 * * * (02:00 UTC every day)
schedule prune-audit-logs "cron(0 2 * * ? *)" pruneAuditLogs
# Gadget's 0 6 * * 1 (Mondays at 06:00): Scheduler counts Sunday as 1, so Monday is 2
schedule weekly-report "cron(0 6 ? * 2 *)" weeklyReport
```

### Sending jobs with Gadget's options

The guide's `enqueue` takes a delay up to 15 minutes. This version takes `api.enqueue`'s `startAt` and `id` as well: a job further ahead becomes a one-time schedule named from its id, so Scheduler drops a second job with the same id until the first one runs, the way `onDuplicateID: "ignore"` did. It also keeps development off AWS when `AWS_ENDPOINT_URL` points at an emulator:

```typescript
// in app/queue.server.ts
import { createHash, randomUUID } from "node:crypto";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { ConflictException, CreateScheduleCommand, SchedulerClient } from "@aws-sdk/client-scheduler";

// without this, the client sends each call to the host in the queue's URL, even with AWS_ENDPOINT_URL set
export const sqs = new SQSClient({ useQueueUrlAsEndpoint: false });
const scheduler = new SchedulerClient({});

export interface EnqueueOptions {
  // Gadget's startAt
  startAt?: Date;
  // Gadget's id with onDuplicateID: "ignore", for jobs that start more than 15 minutes ahead
  id?: string;
}

// https://sqs.us-east-1.amazonaws.com/123456789012/jobs -> arn:aws:sqs:us-east-1:123456789012:jobs
function queueArn(queueUrl: string) {
  const { hostname, pathname } = new URL(queueUrl);
  const [account, name] = pathname.split("/").filter(Boolean);
  return `arn:aws:sqs:${hostname.split(".")[1]}:${account}:${name}`;
}

export async function enqueue(queueUrl: string, job: string, payload: unknown, options: EnqueueOptions = {}) {
  const body = JSON.stringify({ job, payload });
  const seconds = options.startAt ? Math.ceil((options.startAt.getTime() - Date.now()) / 1000) : 0;
  if (seconds <= 900) {
    // SQS delays a message by at most 900 seconds; a time already past runs now, as Gadget would have
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body, DelaySeconds: Math.max(0, seconds) }));
    return;
  }
  // a schedule name holds at most 64 letters, digits, hyphens, underscores, and periods
  const name = `job-${options.id ? createHash("sha256").update(options.id).digest("hex").slice(0, 40) : randomUUID()}`;
  try {
    await scheduler.send(
      new CreateScheduleCommand({
        Name: name,
        ScheduleExpression: `at(${options.startAt!.toISOString().slice(0, 19)})`,
        ScheduleExpressionTimezone: "UTC",
        FlexibleTimeWindow: { Mode: "OFF" },
        // a finished one-time schedule counts against the region's quota until it is deleted
        ActionAfterCompletion: "DELETE",
        Target: { Arn: queueArn(queueUrl), RoleArn: process.env.SCHEDULER_ROLE_ARN!, Input: body },
      })
    );
  } catch (error) {
    // a job with this id is already waiting
    if (!(error instanceof ConflictException)) throw error;
  }
}
```

A one-time schedule is deleted once it runs, so the same id can start a new job after that, where Gadget dropped repeats until a day after the first job succeeded. A job sent to a FIFO queue can't have a delay at all, so a store's `startAt` job always goes through a schedule, and the schedule's target then needs `SqsParameters` with a `MessageGroupId`.

### The scheduled job, safe to run twice or at once

Scheduler delivers at least once, retries only its delivery, and starts the next run whether or not the last one finished. The job records each run's scheduled time in a table with a unique key, and takes a transaction-level advisory lock, which RDS Proxy doesn't pin. It also prunes relative to the scheduled time, so a retry hours later deletes the same rows.

The worker connects as `app_user`, so a delete across every store fails with `unrecognized configuration parameter "app.shop_id"`, or with `invalid input syntax for type bigint: ""` on a connection an earlier job set the store on. [shop-tenancy.md](../shop-tenancy.md#code-that-works-across-stores) offers a role with `bypassrls` for such jobs, but RDS's master user doesn't have `BYPASSRLS`, and PostgreSQL lets only a superuser or a role with it create one. On PostgreSQL 18, `create role maint bypassrls` as a role like the master user fails with `Only roles with the BYPASSRLS attribute may create roles with the BYPASSRLS attribute`. Put the cross-store statement in a `security definer` function instead. It runs as its owner, the master user that runs migrations, which owns the table, and `app_user` can call that function and nothing else across stores:

```sql
-- in prisma/migrations/<timestamp>_schedule_run/migration.sql
-- runs after the guide's app_user exists, because of the grant at the end
create table schedule_run (
  schedule text not null,
  scheduled_at timestamptz not null,
  started_at timestamptz not null default now(),
  primary key (schedule, scheduled_at)
);

-- runs as its owner, which owns audit_log, so row-level security doesn't apply inside it
-- unless the table has force row level security
create function prune_audit_logs(before timestamptz) returns bigint
language sql security definer set search_path = public, pg_temp
as $$
  with deleted as (delete from audit_log where created_at < before returning 1)
  select count(*) from deleted
$$;
-- every role can call a new function until this
revoke all on function prune_audit_logs(timestamptz) from public;
grant execute on function prune_audit_logs(timestamptz) to app_user;
```

```typescript
// in app/jobs.server.ts
import prisma from "./db.server";
import { weeklyReport } from "./services/reports.server";

// the worker's runJob, from the guide's app/worker.server.ts
export async function runJob(job: string, payload: any) {
  switch (job) {
    case "pruneAuditLogs":
      console.log(await pruneAuditLogs(payload.scheduledTime));
      return;
    case "weeklyReport":
      await weeklyReport(payload.scheduledTime);
      return;
    default:
      throw new Error(`no job named ${job}`);
  }
}

// scheduledTime is Scheduler's <aws.scheduler.scheduled-time>, such as 2026-11-13T02:00:00Z
export async function pruneAuditLogs(scheduledTime: string): Promise<string> {
  const scheduledAt = new Date(scheduledTime);
  if (Number.isNaN(scheduledAt.getTime())) throw new Error(`no scheduled time in the job: ${scheduledTime}`);
  return await prisma.$transaction(
    async (tx) => {
      // released at commit, so it works through RDS Proxy and PgBouncer without pinning
      const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`select pg_try_advisory_xact_lock(hashtextextended('schedule:prune-audit-logs', 0)) as locked`;
      // Gadget skipped a run while the last one was still going; this run's row isn't written, so a retry can still run it
      if (!locked) return "skipped: the previous run is still going";

      // a second delivery of the same run inserts nothing; if the delete fails, this insert rolls back with it
      const inserted = await tx.$executeRaw`insert into schedule_run (schedule, scheduled_at) values ('prune-audit-logs', ${scheduledAt}) on conflict do nothing`;
      if (inserted === 0) return `skipped: the run for ${scheduledTime} already finished`;

      // every store's rows, through the function the migration owns; app_user's own delete would fail without a store set
      const [{ deleted }] = await tx.$queryRaw<{ deleted: bigint }[]>`select prune_audit_logs(${scheduledAt}::timestamptz - interval '90 days') as deleted`;
      return `deleted ${deleted} audit_log rows for the run at ${scheduledTime}`;
    },
    // Prisma ends an interactive transaction after 5 seconds by default; keep this under stopTimeout's 120
    { timeout: 100_000, maxWait: 10_000 }
  );
}
```

It's [vercel.md](vercel.md)'s pattern keyed on the scheduled time instead of an execution id, which Scheduler doesn't send. Rows older than a few weeks in `schedule_run` can go in the same job.

### Keeping a long job through a deploy

The guide's third way to run the 12-minute action: the worker marks its own task as protected while the job runs, and ECS leaves it running through deploys and scale-in. The task role needs `ecs:UpdateTaskProtection`, and ECS sets `ECS_AGENT_URI` in every task:

```typescript
// in app/jobs/task-protection.server.ts
async function setProtection(agentUri: string, body: { ProtectionEnabled: boolean; ExpiresInMinutes?: number }) {
  const response = await fetch(`${agentUri}/task-protection/v1/state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // the agent answers { protection } on success, and { failure } or { error } otherwise
  const result = (await response.json().catch(() => ({}))) as { failure?: { Reason?: string }; error?: { Code?: string; Message?: string } };
  if (!response.ok || result.failure || result.error) {
    throw new Error(`task protection failed: ${response.status} ${result.failure?.Reason ?? result.error?.Code ?? ""} ${result.error?.Message ?? ""}`.trim());
  }
}

// runs work while ECS can't stop this task; minutes caps the protection if the process dies without removing it
export async function withTaskProtection<T>(minutes: number, work: () => Promise<T>): Promise<T> {
  const agentUri = process.env.ECS_AGENT_URI;
  // not on ECS, such as in development
  if (!agentUri) return await work();
  await setProtection(agentUri, { ProtectionEnabled: true, ExpiresInMinutes: minutes });
  try {
    return await work();
  } finally {
    // a deploy waits for every protected task, so remove it as soon as the job ends
    await setProtection(agentUri, { ProtectionEnabled: false }).catch((error) => console.error(error));
  }
}
```

For the 12-minute action: `await withTaskProtection(30, () => reconcileShop(shopId))`, inside the worker's job, with the queue's visibility timeout above 12 minutes too. A worker that picks up the next protected job before this one ends keeps its old code until protection expires, so give the long jobs a worker service of their own, with one loop.

## Cutover

The order in [cutover.md](../cutover.md) and the guide's [Cut over to the new platform](https://docs.gadget.dev/guides/moving-to-another-platform/aws#cut-over-to-the-new-platform) holds. On AWS:

- **Allowlist:** list the NAT gateways' Elastic IPs (the command in [Checks to run](#checks-to-run)) and add each as an address in Shopify's IP allowlist, next to Gadget's ASN `396982`. Add AWS's ASN and country only for tasks without fixed addresses, such as tasks in public subnets, as [IP allowlists](https://docs.gadget.dev/guides/moving-to-another-platform/aws#ip-allowlists) describes. Remove `396982` after you delete the Gadget app.
- **Backfill inside the VPC:** run it as a task with `RunTask`, or as jobs on the worker, so its requests leave through the NAT gateways. A backfill from your computer gets `403` once enforcement is on.
- **Load records as `postgres`:** through the Session Manager tunnel, to the instance's endpoint with `sslmode=require`, because the load writes every store's rows without setting `app.shop_id`.
- **Move scheduled work:** `bash scripts/aws-queues.sh ENABLED`, in the same minute you turn off Gadget's scheduler triggers. Then check that `aws scheduler list-schedules` shows each schedule `ENABLED`. Jobs with a future `startAt` go through `enqueue` above.
- **Secrets:** ECS reads each secret when a task starts, so after you change one, run `aws ecs update-service --force-new-deployment` on each service.
- **Rollback:** `aws ecs update-service --cluster my-app --service my-app-web --task-definition my-app-web:41`, and the same for the worker, with the revisions that ran before. It doesn't undo migrations.

## What wasn't verified

No AWS account was used, so nothing ran on Fargate, RDS, RDS Proxy, or a real NAT gateway. Run locally on 12 November 2026:

- `scripts/aws-queues.sh`, both `DISABLED` and then `ENABLED`, and `app/queue.server.ts`, against AWS Emulator 1.0.336 with AWS CLI 2.39.1 and the AWS SDK for JavaScript. The emulator checks the role's trust policy and refuses five-field cron, but it doesn't run schedules, so the scheduled time in a delivered message and one-time schedules deleting themselves come from AWS's docs.
- `pruneAuditLogs`, `prune_audit_logs`, and the guide's `app_user` grants on PostgreSQL 18, as a role with `CREATEROLE` and `CREATEDB` but not `SUPERUSER` or `BYPASSRLS`, standing in for RDS's master user. Whether RDS itself lets its master user create a `BYPASSRLS` role isn't in AWS's docs; the stand-in can't.
- `withTaskProtection` against a stand-in for the ECS agent's endpoint, built from the request and responses on AWS's task scale-in protection page.
- Every TypeScript block, typechecked with the AWS SDK clients and Prisma 6.19.3.

From AWS's docs and the guide's fact-check, not reproduced: RDS Proxy's pinning on `set_config` and how much Prisma pins, the 30-second default and 120-second limit of `stopTimeout` on Fargate, the 1 to 6 hours between task role credential rotations, Aurora's pause and resume times, and the CLI's unencrypted and 1-day defaults for `create-db-instance`.
