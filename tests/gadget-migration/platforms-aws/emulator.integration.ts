// Runs scripts/aws-queues.sh and app/queue.server.ts from aws.md against AWS Emulator, AWS's local emulator
// of SQS, IAM, STS, and Scheduler, with the AWS CLI. Every call goes to the emulator: the environment points
// AWS_ENDPOINT_URL at it, uses its own credentials file, and drops any profile or keys from the shell.
// Needs Docker with an image of the emulator (AWS_EMULATOR_IMAGE, default aws-emulator:latest) and the AWS CLI.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { block } from "../platform-blocks.ts";
import { docker, hasImage, removeContainer, waitFor } from "./docker.ts";

const here = import.meta.dirname;
const IMAGE = process.env.AWS_EMULATOR_IMAGE ?? "aws-emulator:latest";
const NAME = "migcheck-aws-emulator";
const PORT = 57212;
const hasCli = (() => {
  try {
    execFileSync("aws", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();
const skip = !hasImage(IMAGE) ? `needs Docker with ${IMAGE}` : !hasCli ? "needs the AWS CLI" : false;

describe("aws-queues.sh and enqueue against AWS Emulator", { skip }, () => {
  const work = join(here, ".work", "emulator");
  let env: NodeJS.ProcessEnv;
  const aws = (...args: string[]) => execFileSync("aws", [...args, "--output", "json"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const json = (...args: string[]) => JSON.parse(aws(...args) || "{}");
  const queueUrl = (name: string) => json("sqs", "get-queue-url", "--queue-name", name).QueueUrl as string;
  const attributes = (name: string) => json("sqs", "get-queue-attributes", "--queue-url", queueUrl(name), "--attribute-names", "All").Attributes;

  before(async () => {
    removeContainer(NAME);
    docker("run", "-d", "--name", NAME, "-e", "EMULATOR_TELEMETRY=off", "-p", `127.0.0.1:${PORT}:9297`, IMAGE);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(join(work, "app"), { recursive: true });
    await waitFor(() => {
      docker("cp", `${NAME}:/home/emulator/.aws/emulator/9297/emulator_credentials`, join(work, "credentials"));
      docker("cp", `${NAME}:/home/emulator/.aws/emulator/9297/ca.pem`, join(work, "ca.pem"));
      return true;
    }, "the emulator's credentials");
    writeFileSync(join(work, "config"), "");
    env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^AWS_/.test(k)));
    Object.assign(env, {
      AWS_ENDPOINT_URL: `https://127.0.0.1:${PORT}`,
      AWS_CA_BUNDLE: join(work, "ca.pem"),
      AWS_SHARED_CREDENTIALS_FILE: join(work, "credentials"),
      AWS_CONFIG_FILE: join(work, "config"),
      AWS_REGION: "us-east-1",
      NODE_EXTRA_CA_CERTS: join(work, "ca.pem"),
    });
    await waitFor(() => !!json("sts", "get-caller-identity").Account, "the emulator to answer");
    writeFileSync(join(work, "aws-queues.sh"), block("aws.md", "scripts/aws-queues.sh"));
  });

  after(() => removeContainer(NAME));

  it("creates the queues with Gadget's retries and the schedules disabled", () => {
    const output = execFileSync("bash", [join(work, "aws-queues.sh"), "DISABLED"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(output, "prune-audit-logs: DISABLED\nweekly-report: DISABLED\n");
    const jobs = attributes("jobs");
    assert.equal(jobs.VisibilityTimeout, "900");
    assert.deepEqual(JSON.parse(jobs.RedrivePolicy), { deadLetterTargetArn: "arn:aws:sqs:us-east-1:000000000000:jobs-dlq", maxReceiveCount: 7 });
    assert.equal(JSON.parse(attributes("webhooks").RedrivePolicy).maxReceiveCount, 10);
    assert.equal(attributes("jobs-dlq").MessageRetentionPeriod, "1209600");
    assert.equal(attributes("external.fifo").FifoQueue, "true");
    assert.equal(JSON.parse(attributes("external.fifo").RedrivePolicy).deadLetterTargetArn, "arn:aws:sqs:us-east-1:000000000000:external-dlq.fifo");
    const prune = json("scheduler", "get-schedule", "--name", "prune-audit-logs");
    assert.equal(prune.State, "DISABLED");
    assert.equal(prune.ScheduleExpression, "cron(0 2 * * ? *)");
    assert.deepEqual(prune.FlexibleTimeWindow, { Mode: "OFF" });
    assert.deepEqual(JSON.parse(prune.Target.Input), { job: "pruneAuditLogs", payload: { scheduledTime: "<aws.scheduler.scheduled-time>" } });
    assert.equal(json("scheduler", "get-schedule", "--name", "weekly-report").ScheduleExpression, "cron(0 6 ? * 2 *)");
  });

  it("turns the schedules on at the cutover by sending each whole definition again", () => {
    const output = execFileSync("bash", [join(work, "aws-queues.sh"), "ENABLED"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(output, "prune-audit-logs: ENABLED\nweekly-report: ENABLED\n");
    const prune = json("scheduler", "get-schedule", "--name", "prune-audit-logs");
    assert.equal(prune.State, "ENABLED");
    assert.equal(prune.Target.RoleArn, "arn:aws:iam::000000000000:role/my-app-scheduler");
    assert.equal(prune.Target.RetryPolicy.MaximumRetryAttempts, 5);
  });

  it("sends jobs now, delays them up to 15 minutes, and makes one schedule per id further ahead", async () => {
    writeFileSync(join(work, "app/queue.server.ts"), block("aws.md", "app/queue.server.ts"));
    writeFileSync(
      join(work, "run-enqueue.ts"),
      [
        'import { enqueue } from "./app/queue.server.ts";',
        "const queueUrl = process.argv[2];",
        "const later = new Date(Date.now() + 2 * 3600_000);",
        'await enqueue(queueUrl, "notifyExternalSystem", { orderId: "1001" });',
        'await enqueue(queueUrl, "notifyExternalSystem", { orderId: "1002" }, { startAt: new Date(Date.now() + 3000) });',
        'await enqueue(queueUrl, "notifyExternalSystem", { orderId: "1003" }, { startAt: later, id: "notify-1003" });',
        'await enqueue(queueUrl, "notifyExternalSystem", { orderId: "1003" }, { startAt: later, id: "notify-1003" });',
        "console.log(later.toISOString());",
      ].join("\n")
    );
    // inside this folder, so the block's imports of the AWS SDK resolve from its node_modules
    const later = execFileSync(process.execPath, [join(work, "run-enqueue.ts"), queueUrl("jobs")], {
      env: { ...env, SCHEDULER_ROLE_ARN: "arn:aws:iam::000000000000:role/my-app-scheduler" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const receive = () => (json("sqs", "receive-message", "--queue-url", queueUrl("jobs"), "--max-number-of-messages", "10", "--wait-time-seconds", "0").Messages ?? []).map((m: { Body: string }) => JSON.parse(m.Body).payload.orderId);
    assert.deepEqual(receive(), ["1001"]);
    await new Promise((r) => setTimeout(r, 4000));
    assert.deepEqual(receive(), ["1002"]);

    const schedules = json("scheduler", "list-schedules", "--name-prefix", "job-").Schedules;
    assert.equal(schedules.length, 1, "the second job with the same id made no schedule");
    const schedule = json("scheduler", "get-schedule", "--name", schedules[0].Name);
    assert.equal(schedule.ScheduleExpression, `at(${later.slice(0, 19)})`);
    assert.equal(schedule.ScheduleExpressionTimezone, "UTC");
    assert.equal(schedule.ActionAfterCompletion, "DELETE");
    assert.equal(schedule.Target.Arn, "arn:aws:sqs:us-east-1:000000000000:jobs");
    assert.deepEqual(JSON.parse(schedule.Target.Input), { job: "notifyExternalSystem", payload: { orderId: "1003" } });
  });
});
